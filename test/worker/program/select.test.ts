import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
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
 *   own  = i0..i3 (history) ; near = i0,i1,i2 ; i3 has no letters from others (never selected)
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
    [0, 1, 2, 3].map((n) => ({ listenerId: a.id, itemId: i(n), source: "manual" as const, occurredAt: null, rank: null })),
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

  it("seats that near and neighbor cannot fill go to far, never to the listener's own unwritten works", async () => {
    const f = await buildFixture();
    const d = await createListener(env.DB);
    await upsertHistory(env.DB, [{ listenerId: d.id, itemId: f.items[3] as string, source: "manual", occurredAt: null, rank: null }]);
    const p = await selectProgram(env.DB, { ...d, dial: 0.3 }, { seed: "s" });
    expect(p).toHaveLength(6);
    expect(p.some((s) => s.itemId === f.items[3])).toBe(false);
    expect(p.filter((s) => s.slot === "near")).toEqual([]);
    expect(p.every((s) => s.letterIds.length > 0)).toBe(true);
    expect(new Set(p.map((s) => s.itemId)).size).toBe(6);
  });

  it("every selection has at least one letter", async () => {
    const f = await buildFixture();
    const mine = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { seed: "s" });
    const world = await selectProgram(env.DB, f.a, { station: { kind: "world" }, size: 10, seed: "w" });
    expect(mine.length).toBeGreaterThan(0);
    expect(world.length).toBeGreaterThan(0);
    expect([...mine, ...world].every((s) => s.letterIds.length >= 1)).toBe(true);
  });

  it("a new listener whose works nobody has written about still gets a full programme from far letters", async () => {
    const seedWriter = await createListener(env.DB);
    for (let n = 0; n < 12; n++) {
      const it = await insertItem(env.DB, itemDraft({ title: `seeded-${n}`, externalIds: { itunes: `s${n}` } }));
      await insertLetter(env.DB, letterDraft(it.id, { listenerId: seedWriter.id, body: `seed ${n}` }));
    }
    const judge = await createListener(env.DB);
    const mine: string[] = [];
    for (let n = 0; n < 3; n++) {
      const it = await insertItem(env.DB, itemDraft({ title: `mine-${n}`, externalIds: { itunes: `m${n}` } }));
      mine.push(it.id);
      await upsertHistory(env.DB, [{ listenerId: judge.id, itemId: it.id, source: "manual", occurredAt: null, rank: null }]);
    }
    // One of them carries the judge's own one-liner from /start: it still counts as nobody else's.
    await insertLetter(env.DB, letterDraft(mine[0]!, { listenerId: judge.id, body: "my note" }));

    const low = await selectProgram(env.DB, { ...judge, dial: 0.3 }, { seed: "s" });
    expect(low).toHaveLength(6);
    expect(low.some((s) => mine.includes(s.itemId))).toBe(false);
    expect(bySlot(low, "far")).toBe(6);
    expect(low.every((s) => s.letterIds.length > 0)).toBe(true);

    const zero = await selectProgram(env.DB, { ...judge, dial: 0 }, { seed: "s" });
    expect(bySlot(zero, "far")).toBe(6);

    const high = await selectProgram(env.DB, { ...judge, dial: 1 }, { seed: "s" });
    expect(bySlot(high, "far")).toBe(6);
    expect(high.some((s) => mine.includes(s.itemId))).toBe(false);
  });

  it("a listener whose only work has no letters from others gets an empty programme", async () => {
    const d = await createListener(env.DB);
    const only = await insertItem(env.DB, itemDraft({ title: "only" }));
    await upsertHistory(env.DB, [{ listenerId: d.id, itemId: only.id, source: "manual", occurredAt: null, rank: null }]);
    expect(await selectProgram(env.DB, d, { seed: "s" })).toEqual([]);
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

  it("far never picks an item whose only public row is a watashimo", async () => {
    const f = await buildFixture();
    const lone = await insertItem(env.DB, itemDraft({ title: "lone" }));
    await insertLetter(env.DB, letterDraft(lone.id, { kind: "watashimo", listenerId: f.c.id, parentLetterId: f.letters.own[0] as string }));
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const p = await selectProgram(env.DB, { ...f.a, dial: 1 }, { size: 12, seed });
      expect(p.some((s) => s.itemId === lone.id)).toBe(false);
    }
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

    it("is not consumed by an episode of another station", async () => {
      const f = await buildFixture();
      const { x, mine } = await addOwnLetterWithReaction(f, new Date(Date.now() - 60_000).toISOString());
      await insertLetter(env.DB, letterDraft(x.id, { kind: "watashimo", listenerId: f.b.id, parentLetterId: mine.id }));
      await insertEpisode(env.DB, {
        listenerId: f.a.id,
        segments: [],
        verified: true,
        report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
        station: "world",
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      });
      for (const seed of ["s", "t", "u", "v", "w", "x", "y", "z"]) {
        const p = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { seed });
        expect([x.id, f.items[0]]).toContain(p[0]?.itemId);
      }
    });

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

    it("ignores a reaction whose parent letter is no longer public", async () => {
      const f = await buildFixture();
      const { x, mine } = await addOwnLetterWithReaction(f, new Date(Date.now() - 60_000).toISOString());
      await insertLetter(env.DB, letterDraft(x.id, { kind: "watashimo", listenerId: f.b.id, parentLetterId: mine.id }));
      await setLetterStatus(env.DB, mine.id, "rejected");
      // The fixture's own watashimo on item 0 is newer too, so only item 0 may lead.
      for (const seed of ["s", "t", "u", "v", "w", "x", "y", "z"]) {
        const p = await selectProgram(env.DB, { ...f.a, dial: 0.3 }, { seed });
        expect(p[0]?.itemId).not.toBe(x.id);
      }
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

describe("selectProgram stations", () => {
  beforeEach(() => resetDb(env.DB));

  it("world: a brand-new listener gets far items only, with others' letters", async () => {
    await buildFixture();
    const fresh = await createListener(env.DB);
    const p = await selectProgram(env.DB, fresh, { station: { kind: "world" }, size: 3, seed: "w" });
    expect(p).toHaveLength(3);
    expect(p.every((s) => s.slot === "far" && s.letterIds.length > 0)).toBe(true);
    expect(new Set(p.map((s) => s.itemId)).size).toBe(3);
  });

  it("world: no echo and no own works for a listener with history", async () => {
    const f = await buildFixture();
    const p = await selectProgram(env.DB, f.a, { station: { kind: "world" }, size: 10, seed: "w" });
    const own = new Set(f.items.slice(0, 4));
    expect(p.length).toBeGreaterThan(0);
    expect(p.every((s) => s.slot === "far" && !own.has(s.itemId))).toBe(true);
  });

  it("a public station reads only works that someone has written about, never the listener's own letters", async () => {
    const owner = await createListener(env.DB);
    const guest = await createListener(env.DB);
    const other = await createListener(env.DB);
    const items: string[] = [];
    for (let n = 0; n < 4; n++) items.push((await insertItem(env.DB, itemDraft({ title: `fav-${n}` }))).id);
    const outsider = (await insertItem(env.DB, itemDraft({ title: "not-a-favourite" }))).id;
    await upsertHistory(env.DB, [
      { listenerId: owner.id, itemId: items[0] as string, source: "manual", occurredAt: null, rank: 1 },
      { listenerId: owner.id, itemId: items[1] as string, source: "url", occurredAt: null, rank: 2 },
      { listenerId: owner.id, itemId: items[2] as string, source: "manual", occurredAt: null, rank: null },
      { listenerId: owner.id, itemId: items[3] as string, source: "spotify", occurredAt: null, rank: 3 },
    ]);
    await insertLetter(env.DB, letterDraft(items[0] as string, { listenerId: other.id, body: "other on 0" }));
    await insertLetter(env.DB, letterDraft(items[0] as string, { listenerId: owner.id, body: "owner on 0" }));
    await insertLetter(env.DB, letterDraft(outsider, { listenerId: other.id, body: "other on outsider" }));

    const p = await selectProgram(env.DB, guest, { station: { kind: "public", ownerId: owner.id }, size: 6, seed: "p" });
    expect(p.map((s) => s.itemId)).toEqual([items[0]]);
    expect(p.every((s) => s.slot === "near" && s.letterIds.length > 0)).toBe(true);
    expect(p.find((s) => s.itemId === items[0])?.letterIds).toHaveLength(2);

    const ownerListening = await selectProgram(env.DB, owner, { station: { kind: "public", ownerId: owner.id }, size: 6, seed: "p" });
    expect(ownerListening.find((s) => s.itemId === items[0])?.letterIds).toHaveLength(1);
    expect(ownerListening.every((s) => s.letterIds.length > 0)).toBe(true);
    const letters = await env.DB.prepare("SELECT id FROM letters WHERE listener_id = ?").bind(owner.id).all<{ id: string }>();
    const ownIds = new Set(letters.results.map((r) => r.id));
    expect(ownerListening.flatMap((s) => s.letterIds).some((id) => ownIds.has(id))).toBe(false);
  });
});

describe("selectProgram with one seat", () => {
  beforeEach(() => resetDb(env.DB));
  const seeds = ["s", "t", "u", "v", "w"];

  it("lets the dial pick the pool: low near, middle neighbor, high far", async () => {
    const f = await buildFixture();
    for (const seed of seeds) {
      expect((await selectProgram(env.DB, f.a, { size: 1, seed, dial: 0 })).map((s) => s.slot)).toEqual(["near"]);
      expect((await selectProgram(env.DB, f.a, { size: 1, seed, dial: 0.5 })).map((s) => s.slot)).toEqual(["neighbor"]);
      expect((await selectProgram(env.DB, f.a, { size: 1, seed, dial: 1 })).map((s) => s.slot)).toEqual(["far"]);
    }
  });

  it("takes the dial from the request over the stored one", async () => {
    const f = await buildFixture();
    const p = await selectProgram(env.DB, { ...f.a, dial: 1 }, { size: 1, seed: "s", dial: 0 });
    expect(p.map((s) => s.slot)).toEqual(["near"]);
  });

  it("falls back far, then near, then neighbor when the dial's pool is empty", async () => {
    const f = await buildFixture();
    // C's own items are i5..i11; only C and the found voice "zed" wrote there, so C has no neighbor.
    const p = await selectProgram(env.DB, f.c, { size: 1, seed: "s", dial: 0.5 });
    expect(p.map((s) => s.slot)).toEqual(["far"]);
  });

  it("gives the seat to the echo whatever the dial says", async () => {
    const f = await buildFixture();
    const x = await insertItem(env.DB, itemDraft({ title: "echo" }));
    const mine = await insertLetter(env.DB, letterDraft(x.id, { listenerId: f.a.id, body: "A on echo" }));
    await insertEpisode(env.DB, { listenerId: f.a.id, segments: [], verified: true, report: { verbatim: true, sources: true, topical: true, pii: true, details: [] }, createdAt: new Date(Date.now() - 60_000).toISOString() });
    await insertLetter(env.DB, letterDraft(x.id, { kind: "watashimo", listenerId: f.b.id, parentLetterId: mine.id }));
    for (const seed of seeds) {
      const p = await selectProgram(env.DB, f.a, { size: 1, seed, dial: 1 });
      expect(p).toHaveLength(1);
      expect(p[0]?.slot).toBe("near");
      expect([x.id, f.items[0]]).toContain(p[0]?.itemId);
    }
  });

  it("seats a letter the listener asked for, read first, with the slot its item has", async () => {
    const f = await buildFixture();
    const asked = await insertLetter(env.DB, letterDraft(f.items[9]!, { listenerId: f.b.id, body: "B on 9" }));
    const p = await selectProgram(env.DB, f.a, { size: 1, seed: "s", dial: 0, letterId: asked.id });
    expect(p).toHaveLength(1);
    // B also wrote on A's i0, so i9 is in A's neighbor pool now.
    expect(p[0]).toMatchObject({ itemId: f.items[9], slot: "neighbor" });
    expect(p[0]!.letterIds[0]).toBe(asked.id);
  });

  it("seats a sourced found voice too", async () => {
    const f = await buildFixture();
    const voice = await insertLetter(env.DB, letterDraft(f.items[1]!, { kind: "found", sourceAuthor: "hana", sourceUrl: "https://example.com/hana", body: "hana on 1" }));
    const p = await selectProgram(env.DB, f.a, { size: 1, seed: "s", dial: 1, letterId: voice.id });
    expect(p[0]).toMatchObject({ itemId: f.items[1], slot: "near" });
    expect(p[0]!.letterIds[0]).toBe(voice.id);
  });

  it("ignores an asked letter that is the listener's own, not public, a reaction, unknown, or a found voice without a source", async () => {
    const f = await buildFixture();
    const hidden = await insertLetter(env.DB, letterDraft(f.items[9]!, { listenerId: f.b.id, body: "hidden" }));
    await setLetterStatus(env.DB, hidden.id, "rejected");
    const bare = await insertLetter(env.DB, letterDraft(f.items[10]!, { kind: "found", sourceAuthor: null, sourceUrl: null, body: "no source" }));
    for (const id of [f.letters.own[0]!, hidden.id, f.letters.watashimo[0]!, bare.id, "no-such-letter"]) {
      const p = await selectProgram(env.DB, f.a, { size: 1, seed: "s", dial: 0, letterId: id });
      expect(p).toHaveLength(1);
      expect(p[0]?.slot).toBe("near");
      expect(p[0]!.letterIds).not.toContain(id);
    }
  });
});
