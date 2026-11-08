import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBED_MODEL, embed, embedItems, embedLetters, ensureItemVectors, ensureLetterVectors, itemText, remixAfterTakedown } from "../../../src/worker/ai/embed";
import { dequantise, getItemVecs, insertItem, refreshItemMix, setItemVec, VEC_DIMS } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus, setLetterVecs } from "../../../src/worker/db/letters";
import { angled, fakeAi } from "../../helpers/ai";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

beforeEach(async () => {
  await resetDb(env.DB);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("embed", () => {
  it("asks bge-m3 for every text and gives unit vectors in order", async () => {
    const { AI, calls } = fakeAi(async (_m, input) => ({ data: input.text.map((_, i) => Array.from({ length: VEC_DIMS }, (_, k) => (k === i ? 3 : k === i + 1 ? 4 : 0))) }));
    const out = await embed({ AI }, ["a", "b"]);
    expect(calls).toEqual([{ model: EMBED_MODEL, text: ["a", "b"] }]);
    expect(EMBED_MODEL).toBe("@cf/baai/bge-m3");
    expect(out).toHaveLength(2);
    expect(out![0]![0]).toBeCloseTo(0.6);
    expect(out![0]![1]).toBeCloseTo(0.8);
    expect(out![1]![1]).toBeCloseTo(0.6);
    for (const v of out!) expect(Math.hypot(...v)).toBeCloseTo(1);
  });

  it("gives null without the binding, and says so once as a warning, not an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await embed({}, ["a"])).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it("gives null when the call throws or answers out of shape, and logs the error's name only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "a title nobody should log";
    expect(await embed(fakeAi(async () => { throw new Error(`boom ${secret}`); }), [secret])).toBeNull();
    expect(await embed(fakeAi(async () => ({ data: [[1, 2]] })), [secret])).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
    for (const [line] of error.mock.calls) {
      expect(String(line)).toMatch(/^\[dococa\] embed failed: \w+$/);
      expect(String(line)).not.toContain(secret);
    }
  });
});

describe("embedItems", () => {
  it("embeds the work's public metadata, 20 to a call, and skips works that already have a vector", async () => {
    const items = [];
    for (let n = 0; n < 23; n++) items.push(await insertItem(env.DB, itemDraft({ title: `曲${n}`, creator: "誰か", year: n === 0 ? null : 2001, kind: "music" })));
    const { AI, calls } = fakeAi();
    expect(await embedItems({ AI }, env.DB, items.map((i) => i.id))).toBe(23);
    expect(calls.map((c) => c.text.length)).toEqual([20, 3]);
    expect(calls.flatMap((c) => c.text)).toContain("曲0 — 誰か [music]");
    expect(calls.flatMap((c) => c.text)).toContain("曲1 — 誰か (2001) [music]");
    expect((await getItemVecs(env.DB, items.map((i) => i.id))).size).toBe(23);

    expect(await embedItems({ AI }, env.DB, items.map((i) => i.id))).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("does nothing without the binding, and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const item = await insertItem(env.DB, itemDraft());
    expect(await embedItems({}, env.DB, [item.id])).toBe(0);
    expect(await embedItems(fakeAi(async () => { throw new Error("down"); }), env.DB, [item.id])).toBe(0);
    expect((await getItemVecs(env.DB, [item.id])).size).toBe(0);
  });

  it("retries a failing batch one by one, skips the work that fails alone (logging its id and the error name), and moves on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const items = [];
    for (let n = 0; n < 25; n++) items.push(await insertItem(env.DB, itemDraft({ title: n === 3 ? "毒の題名" : `曲${n}` })));
    const poison = items[3]!;
    const ok = fakeAi().AI;
    const { AI, calls } = fakeAi(async (model, input) => {
      if (input.text.some((t) => t.includes("毒"))) throw new TypeError("refused");
      return ok.run(model as Parameters<Ai["run"]>[0], input as never);
    });
    expect(await embedItems({ AI }, env.DB, items.map((i) => i.id))).toBe(24);
    const vecs = await getItemVecs(env.DB, items.map((i) => i.id));
    expect(vecs.size).toBe(24);
    expect(vecs.has(poison.id)).toBe(false);
    const logged = warn.mock.calls.map((c) => c.join(" "));
    expect(logged).toContain(`[dococa] embed skipped ${poison.id} TypeError`);
    expect(logged.join("\n")).not.toContain("毒");
    // The failing batch is retried one by one; the other batch is one call.
    const failed = calls.find((c) => c.text.length > 1 && c.text.some((t) => t.includes("毒")))!;
    expect(calls.filter((c) => c.text.length === 1)).toHaveLength(failed.text.length);
    expect(calls.filter((c) => c.text.length > 1).map((c) => c.text.length).sort()).toEqual([20, 5]);
    // The backfill no longer stalls on it: only the skipped work is left.
    expect(await ensureItemVectors({ AI }, env.DB, 5)).toMatchObject({ remaining: 1 });
  });

  it("stops when every work of a failing batch fails alone too: Workers AI is down, not one work", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const items = [];
    for (let n = 0; n < 25; n++) items.push(await insertItem(env.DB, itemDraft({ title: `曲${n}` })));
    const { AI, calls } = fakeAi(async () => {
      throw new Error("down");
    });
    expect(await embedItems({ AI }, env.DB, items.map((i) => i.id))).toBe(0);
    expect(calls).toHaveLength(21);
  });

  it("itemText is title, creator, year and kind", () => {
    expect(itemText({ title: "T", creator: "C", year: 1999, kind: "book" })).toBe("T — C (1999) [book]");
  });
});

describe("ensureItemVectors", () => {
  it("embeds up to budget × 20 works without a vector and counts what is left", async () => {
    for (let n = 0; n < 25; n++) await insertItem(env.DB, itemDraft({ title: `t${n}` }));
    const { AI } = fakeAi();
    expect(await ensureItemVectors({ AI }, env.DB, 1)).toEqual({ made: 20, remaining: 5 });
    expect(await ensureItemVectors({ AI }, env.DB, 1)).toEqual({ made: 5, remaining: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await insertItem(env.DB, itemDraft({ title: "new" }));
    expect(await ensureItemVectors({}, env.DB, 5)).toEqual({ made: 0, remaining: 1 });
  });
});

const letterVec = async (id: string) => dequantise((await env.DB.prepare("SELECT vec FROM letters WHERE id = ?").bind(id).first<{ vec: unknown }>())?.vec);
const mixOf = async (id: string) => dequantise((await env.DB.prepare("SELECT vec_mix FROM items WHERE id = ?").bind(id).first<{ vec_mix: unknown }>())?.vec_mix);

describe("embedLetters", () => {
  it("embeds public letters and 一言 as their work's text and their own, as written; never a 私も, a found voice or a withdrawn letter", async () => {
    const item = await insertItem(env.DB, itemDraft({ title: "T", creator: "C", year: 1999, kind: "book" }));
    const letter = await insertLetter(env.DB, letterDraft(item.id, { body: "雨の日に読んだ", bodyJa: "雨の日に読んだ" }));
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: letter.id, body: "me too, in the rain" }));
    const watashimo = await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: letter.id, body: "私も" }));
    const found = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", body: "from the web", sourceUrl: "https://example.com/r", sourceAuthor: "someone" }));
    const withdrawn = await insertLetter(env.DB, letterDraft(item.id, { body: "取り下げ" }));
    await setLetterStatus(env.DB, withdrawn.id, "withdrawn");
    const { AI, calls } = fakeAi();
    const ids = [letter.id, reply.id, watashimo.id, found.id, withdrawn.id];
    expect(await embedLetters({ AI }, env.DB, { ids })).toBe(2);
    expect(calls.flatMap((c) => c.text).sort()).toEqual(["T — C (1999) [book]\nme too, in the rain", "T — C (1999) [book]\n雨の日に読んだ"]);
    expect(await letterVec(letter.id)).not.toBeNull();
    expect(await letterVec(reply.id)).not.toBeNull();
    for (const l of [watashimo, found, withdrawn]) expect(await letterVec(l.id)).toBeNull();
    // Already embedded: nothing is asked again.
    expect(await embedLetters({ AI }, env.DB, { ids })).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("logs neither a letter's text nor a vector when Workers AI refuses, and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const item = await insertItem(env.DB, itemDraft());
    const letter = await insertLetter(env.DB, letterDraft(item.id, { body: "誰にも見せない一文" }));
    expect(await embedLetters(fakeAi(async () => { throw new TypeError("refused 誰にも見せない一文"); }), env.DB, { ids: [letter.id] })).toBe(0);
    expect(await embedLetters({}, env.DB, { ids: [letter.id] })).toBe(0);
    const logged = [...warn.mock.calls, ...error.mock.calls].map((c) => c.join(" ")).join("\n");
    expect(logged).not.toContain("誰にも見せない");
    expect(await letterVec(letter.id)).toBeNull();
  });
});

describe("refreshItemMix", () => {
  it("mixes the work's vector with the mean of its public letters' and 一言's, and selection reads the mix", async () => {
    const item = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await setItemVec(env.DB, item.id, angled(0));
    const a = await insertLetter(env.DB, letterDraft(item.id, { body: "a" }));
    const b = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: a.id, body: "b" }));
    const w = await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: a.id, body: "私も" }));
    await setLetterVecs(env.DB, [[a.id, angled(Math.PI / 2)], [b.id, angled(Math.PI / 2)], [w.id, angled(Math.PI)]]);
    await refreshItemMix(env.DB, item.id);
    // vec + mean(letters) = (1, 0) + (0, 1): halfway, whatever a 私も carries.
    const mix = (await mixOf(item.id))!;
    expect(mix[0]).toBeCloseTo(Math.SQRT1_2, 2);
    expect(mix[1]).toBeCloseTo(Math.SQRT1_2, 2);
    expect((await getItemVecs(env.DB, [item.id])).get(item.id)![1]).toBeCloseTo(Math.SQRT1_2, 2);

    // A letter that stops being public leaves the mix; with none left, the work is itself again.
    await setLetterStatus(env.DB, a.id, "withdrawn");
    await setLetterStatus(env.DB, b.id, "rejected");
    await remixAfterTakedown(env.DB, a.id);
    expect(await mixOf(item.id)).toBeNull();
    expect((await getItemVecs(env.DB, [item.id])).get(item.id)![0]).toBeCloseTo(1, 2);
  });

  it("is made when a letter's vector is, and mended by the prepare stage when the work had no vector yet", async () => {
    const item = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    const letter = await insertLetter(env.DB, letterDraft(item.id, { body: "x" }));
    const { AI } = fakeAi();
    expect(await ensureLetterVectors({ AI }, env.DB, 1)).toEqual({ made: 1, remaining: 0 });
    // The work had no vector of its own yet: no mix.
    expect(await mixOf(item.id)).toBeNull();
    await embedItems({ AI }, env.DB, [item.id]);
    expect(await ensureLetterVectors({ AI }, env.DB, 1)).toEqual({ made: 0, remaining: 0 });
    expect(await mixOf(item.id)).not.toBeNull();
    expect(await letterVec(letter.id)).not.toBeNull();
  });

  it("counts every public letter as remaining without Workers AI", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id, { body: "x" }));
    expect(await ensureLetterVectors({}, env.DB, 5)).toEqual({ made: 0, remaining: 1 });
  });
});
