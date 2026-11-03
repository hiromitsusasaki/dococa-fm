import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { findItemByExternalId, getItem, insertItem, searchItems } from "../../../src/worker/db/items";
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
});
