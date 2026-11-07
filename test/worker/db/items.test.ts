import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { countItemsWithoutVec, findItemByExternalId, getItem, getItemVecs, insertItem, listItemsWithoutVec, searchItems, setItemReading, setItemVec, VEC_DIMS } from "../../../src/worker/db/items";
import { angled } from "../../helpers/ai";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "./helpers";

describe("items", () => {
  beforeEach(() => resetDb(env.DB));

  it("insertItem then getItem returns the same values", async () => {
    const draft = itemDraft();
    const inserted = await insertItem(env.DB, draft);
    expect(inserted.id).toMatch(/^[0-9a-f-]{36}$/);
    const got = await getItem(env.DB, inserted.id);
    expect(got).toEqual(inserted);
    expect(got).toMatchObject(draft);
  });

  it("getItem returns null for an unknown id", async () => {
    expect(await getItem(env.DB, "nope")).toBeNull();
  });

  it("findItemByExternalId finds by json key", async () => {
    const a = await insertItem(env.DB, itemDraft());
    await insertItem(env.DB, itemDraft({ title: "Other", externalIds: { itunes: "1" } }));
    expect((await findItemByExternalId(env.DB, "itunes", "1669547856"))?.id).toBe(a.id);
    expect(await findItemByExternalId(env.DB, "spotify", "1669547856")).toBeNull();
  });

  it("findItemByExternalId accepts hyphenated keys", async () => {
    const a = await insertItem(env.DB, itemDraft({ externalIds: { "google-books": "abc123" } }));
    expect((await findItemByExternalId(env.DB, "google-books", "abc123"))?.id).toBe(a.id);
  });

  it("findItemByExternalId rejects unsafe keys", async () => {
    await expect(findItemByExternalId(env.DB, "a'b", "x")).rejects.toThrow();
  });

  it("searchItems matches title or creator case-insensitively, newest first, escaping wildcards", async () => {
    const a = await insertItem(env.DB, itemDraft({ title: "Kind of Blue", creator: "Miles Davis" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await insertItem(env.DB, itemDraft({ title: "Bitches Brew", creator: "MILES DAVIS", externalIds: {} }));
    await insertItem(env.DB, itemDraft({ title: "100% Pure", creator: "Someone", externalIds: {} }));
    expect((await searchItems(env.DB, "miles", 10)).map((i) => i.id)).toEqual([b.id, a.id]);
    expect((await searchItems(env.DB, "kind of", 10)).map((i) => i.id)).toEqual([a.id]);
    expect(await searchItems(env.DB, "%", 10)).toHaveLength(1);
    expect(await searchItems(env.DB, "_", 10)).toHaveLength(0);
  });

  it("searchItems caps limit at 20", async () => {
    for (let i = 0; i < 22; i++) await insertItem(env.DB, itemDraft({ title: `Song ${i}`, externalIds: {} }));
    expect(await searchItems(env.DB, "song", 100)).toHaveLength(20);
  });

  it("stores a vector as 1024 Int8 bytes and reads it back as a unit vector close to the one given", async () => {
    const a = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    const b = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await setItemVec(env.DB, a.id, angled(0.5).map((x) => x * 3));
    const row = await env.DB.prepare("SELECT length(vec) AS n FROM items WHERE id = ?").bind(a.id).first<{ n: number }>();
    expect(row?.n).toBe(VEC_DIMS);
    const vecs = await getItemVecs(env.DB, [a.id, b.id]);
    expect([...vecs.keys()]).toEqual([a.id]);
    const v = vecs.get(a.id)!;
    expect(v[0]).toBeCloseTo(Math.cos(0.5), 2);
    expect(v[1]).toBeCloseTo(Math.sin(0.5), 2);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });

  it("an item read back never carries its vector", async () => {
    const a = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await setItemVec(env.DB, a.id, angled(0));
    expect(Object.keys((await getItem(env.DB, a.id))!)).not.toContain("vec");
  });

  it("lists and counts the items still without a vector, newest first", async () => {
    const old = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await env.DB.prepare("UPDATE items SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").bind(old.id).run();
    const fresh = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    const done = await insertItem(env.DB, itemDraft({ externalIds: {} }));
    await setItemVec(env.DB, done.id, angled(0));
    expect(await listItemsWithoutVec(env.DB, 10)).toEqual([fresh.id, old.id]);
    expect(await listItemsWithoutVec(env.DB, 1)).toEqual([fresh.id]);
    expect(await countItemsWithoutVec(env.DB)).toBe(2);
  });

  it("stores the work's reading only while it has none, and reads it back", async () => {
    const it = await insertItem(env.DB, itemDraft({ creator: "PSY" }));
    expect(await getItem(env.DB, it.id)).not.toHaveProperty("readingJa");
    await setItemReading(env.DB, it.id, {});
    expect(await getItem(env.DB, it.id)).not.toHaveProperty("readingJa");
    await setItemReading(env.DB, it.id, { creator: "サイ" });
    expect((await getItem(env.DB, it.id))!.readingJa).toEqual({ creator: "サイ" });
    await setItemReading(env.DB, it.id, { title: "カンナムスタイル", creator: "ピーエスワイ" });
    expect((await getItem(env.DB, it.id))!.readingJa).toEqual({ creator: "サイ" });
  });
});
