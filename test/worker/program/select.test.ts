import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import { seededRng, selectProgram, shuffle } from "../../../src/worker/program/select";
import type { Letter, Listener } from "../../../src/worker/types";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

type Fixture = {
  a: Listener;
  b: Listener;
  c: Listener;
  items: string[];
  letters: { own: string[]; watashimo: string[]; i0Letters: Letter[] };
};

/**
 * 12 items, 3 listeners. For listener A:
 *   own  = i0..i3 (history) ; near = i0,i1,i2 ; fallback = i3 (no letters)
 *   neighbor = i4 (B wrote on A's i0, and B also wrote on i4)
 *   far = i5..i11 (written by C and an unrelated source author)
 */
async function buildFixture(): Promise<Fixture> {
  const a = await createListener(env.DB);
  const b = await createListener(env.DB);
  const c = await createListener(env.DB);
  const items: string[] = [];
  for (let n = 0; n < 12; n++) items.push((await insertItem(env.DB, itemDraft({ title: `item-${n}` }))).id);
  const i = (n: number) => items[n] as string;
  await upsertHistory(
    env.DB,
    [0, 1, 2, 3].map((n) => ({ listenerId: a.id, itemId: i(n), source: "manual" as const, occurredAt: null })),
  );
  const put = (itemId: string, over: Parameters<typeof letterDraft>[1]) => insertLetter(env.DB, letterDraft(itemId, over));

  const ownA0 = await put(i(0), { listenerId: a.id, body: "A on 0" });
  const ownA2 = await put(i(2), { listenerId: a.id, body: "A on 2" });
  const i0Letters: Letter[] = [await put(i(0), { listenerId: b.id, body: "B on 0" })];
  for (const who of ["alice", "bob", "carol", "dave"]) {
    i0Letters.push(await put(i(0), { kind: "found", sourceAuthor: who, sourceUrl: `https://example.com/${who}`, body: `${who} on 0` }));
  }
  const w0 = await put(i(0), { kind: "watashimo", listenerId: b.id, parentLetterId: ownA0.id, body: "me too" });
  await put(i(1), { kind: "found", sourceAuthor: "erin", sourceUrl: "https://example.com/erin", body: "erin on 1" });
  await put(i(1), { kind: "found", sourceAuthor: "frank", sourceUrl: "https://example.com/frank", body: "frank on 1" });
  await put(i(2), { kind: "found", sourceAuthor: "gina", sourceUrl: "https://example.com/gina", body: "gina on 2" });
  await put(i(4), { listenerId: b.id, body: "B on 4" });
  for (let n = 5; n <= 11; n++) await put(i(n), { listenerId: c.id, body: `C on ${n}` });
  for (let n = 5; n <= 7; n++) {
    await put(i(n), { kind: "found", sourceAuthor: "zed", sourceUrl: "https://example.com/zed", body: `zed on ${n}` });
  }
  return { a, b, c, items, letters: { own: [ownA0.id, ownA2.id], watashimo: [w0.id], i0Letters } };
}

const bySlot = (p: { slot: string }[], slot: string) => p.filter((s) => s.slot === slot).length;

describe("selectProgram", () => {
  beforeEach(() => resetDb(env.DB));

  it("seededRng is deterministic and shuffle keeps the elements", () => {
    const r1 = seededRng("x");
    const r2 = seededRng("x");
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
    const out = shuffle([1, 2, 3, 4, 5, 6], seededRng("y"));
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("dial=0.3 gives far 2, near 3, neighbor 1 with the three kinds mixed", async () => {
    const f = await buildFixture();
    const p = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { seed: "s" });
    expect(p).toHaveLength(6);
    expect(bySlot(p, "far")).toBe(2);
    expect(bySlot(p, "near")).toBe(3);
    expect(bySlot(p, "neighbor")).toBe(1);
    expect(new Set(p.map((s) => s.itemId)).size).toBe(6);
    expect(p[0]?.slot).toBe("near");
    expect(p.findIndex((s) => s.slot === "far")).toBeLessThan(p.length - 1);
    expect(p.filter((s) => s.slot === "near").every((s) => f.items.slice(0, 3).includes(s.itemId))).toBe(true);
    expect(p.find((s) => s.slot === "neighbor")?.itemId).toBe(f.items[4]);
  });

  it("selectProgram_dial_extremes", async () => {
    const f = await buildFixture();
    const low = await selectProgram(env.DB, { ...f.a, dial: 0 }, { seed: "s" });
    expect(bySlot(low, "far")).toBeGreaterThanOrEqual(1);
    const high = await selectProgram(env.DB, { ...f.a, dial: 1 }, { size: 6, seed: "s" });
    expect(high).toHaveLength(6);
    expect(bySlot(high, "far")).toBe(6);
  });

  it("fills from far when the near pool is empty and keeps length 6", async () => {
    const f = await buildFixture();
    const d = await createListener(env.DB);
    await upsertHistory(env.DB, [{ listenerId: d.id, itemId: f.items[3] as string, source: "manual", occurredAt: null }]);
    const p = await selectProgram(env.DB, { ...d, dial: 0.3 }, { seed: "s" });
    expect(p).toHaveLength(6);
    expect(bySlot(p, "far")).toBe(6);
    expect(new Set(p.map((s) => s.itemId)).size).toBe(6);
  });

  it("uses history-only items as the last resort and never pads with duplicates", async () => {
    const d = await createListener(env.DB);
    const only = await insertItem(env.DB, itemDraft({ title: "only" }));
    await upsertHistory(env.DB, [{ listenerId: d.id, itemId: only.id, source: "manual", occurredAt: null }]);
    const p = await selectProgram(env.DB, d, { seed: "s" });
    expect(p).toEqual([{ itemId: only.id, slot: "near", letterIds: [] }]);
  });

  it("letterIds hold at most 3, never own letters, never watashimo", async () => {
    const f = await buildFixture();
    const forbidden = new Set([...f.letters.own, ...f.letters.watashimo]);
    for (const seed of ["a", "b", "c", "d"]) {
      const p = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { seed });
      for (const seg of p) {
        expect(seg.letterIds.length).toBeLessThanOrEqual(3);
        for (const id of seg.letterIds) expect(forbidden.has(id)).toBe(false);
      }
      const seg0 = p.find((s) => s.itemId === f.items[0]);
      expect(seg0?.letterIds).toHaveLength(3);
      const allowed = new Set(f.letters.i0Letters.map((l) => l.id));
      for (const id of seg0?.letterIds ?? []) expect(allowed.has(id)).toBe(true);
    }
  });

  it("is deterministic for a seed and varies across seeds", async () => {
    const f = await buildFixture();
    const l = { ...f.a, dial: 0.3 };
    const first = await selectProgram(env.DB, l, { seed: "same" });
    expect(await selectProgram(env.DB, l, { seed: "same" })).toEqual(first);
    const base = first.map((s) => s.itemId).join();
    let differed = false;
    for (const seed of ["1", "2", "3", "4", "5"]) {
      const p = await selectProgram(env.DB, l, { seed });
      if (p.map((s) => s.itemId).join() !== base) differed = true;
    }
    expect(differed).toBe(true);
  });

  describe("反響", () => {
    const addOwnLetterWithReaction = async (f: Fixture, episodeCreatedAt: string) => {
      const x = await insertItem(env.DB, itemDraft({ title: "echo" }));
      const mine = await insertLetter(env.DB, letterDraft(x.id, { listenerId: f.a.id, body: "A on echo" }));
      await insertEpisode(env.DB, {
        listenerId: f.a.id,
        segments: [],
        verified: true,
        report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
        createdAt: episodeCreatedAt,
      });
      return { x, mine };
    };

    it("puts the item that got a reaction since the last episode first, as near", async () => {
      const f = await buildFixture();
      const { x, mine } = await addOwnLetterWithReaction(f, new Date(Date.now() - 60_000).toISOString());
      await insertLetter(env.DB, letterDraft(x.id, { kind: "watashimo", listenerId: f.b.id, parentLetterId: mine.id }));
      // The fixture's own watashimo on item 0 is also newer than the episode, so either may lead.
      const leaders = new Set<string>();
      for (const seed of ["s", "t", "u", "v", "w", "x", "y", "z"]) {
        const p = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { seed });
        expect(p[0]?.slot).toBe("near");
        leaders.add(p[0]?.itemId as string);
        expect([x.id, f.items[0]]).toContain(p[0]?.itemId);
        expect(p).toHaveLength(6);
        expect(bySlot(p, "near")).toBe(3);
        expect(new Set(p.map((s) => s.itemId)).size).toBe(6);
      }
      expect(leaders).toEqual(new Set([x.id, f.items[0]]));
    });

    it("does not overflow size or break dial=1 when an echo exists", async () => {
      const f = await buildFixture();
      const { x, mine } = await addOwnLetterWithReaction(f, new Date(Date.now() - 60_000).toISOString());
      await insertLetter(env.DB, letterDraft(x.id, { kind: "watashimo", listenerId: f.b.id, parentLetterId: mine.id }));
      const high = await selectProgram(env.DB, { ...f.a, dial: 1 }, { size: 6, seed: "s" });
      expect(high).toHaveLength(6);
      expect(bySlot(high, "far")).toBe(6);
      const mid = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { size: 6, seed: "s" });
      expect(mid).toHaveLength(6);
      expect(mid[0]?.slot).toBe("near");
      expect(bySlot(mid, "near")).toBe(3);
    });

    it("ignores a reaction older than the last episode", async () => {
      const f = await buildFixture();
      const x = await insertItem(env.DB, itemDraft({ title: "echo" }));
      const mine = await insertLetter(env.DB, letterDraft(x.id, { listenerId: f.a.id, body: "A on echo" }));
      await insertLetter(env.DB, letterDraft(x.id, { kind: "watashimo", listenerId: f.b.id, parentLetterId: mine.id }));
      await insertEpisode(env.DB, {
        listenerId: f.a.id,
        segments: [],
        verified: true,
        report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const p = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { seed: "s" });
      expect(p.some((s) => s.itemId === x.id)).toBe(false);
    });
  });
});
