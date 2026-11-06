import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBED_MODEL, embed, embedItems, ensureItemVectors, itemText } from "../../../src/worker/ai/embed";
import { getItemVecs, insertItem, VEC_DIMS } from "../../../src/worker/db/items";
import { fakeAi } from "../../helpers/ai";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "../db/helpers";

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
