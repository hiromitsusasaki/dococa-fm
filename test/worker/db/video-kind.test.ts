import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../../../migrations/0025_video_kind.sql?raw";
import { insertItem } from "../../../src/worker/db/items";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "./helpers";

beforeEach(() => resetDb(env.DB));

describe("0025_video_kind", () => {
  it("moves music items that came from YouTube to video and leaves the rest", async () => {
    const byId = await insertItem(env.DB, itemDraft({ title: "A", externalIds: { youtube: "abc" }, outLinks: {} }));
    const byLink = await insertItem(env.DB, itemDraft({ title: "B", outLinks: { youtube: "https://youtu.be/abc" } }));
    const plain = await insertItem(env.DB, itemDraft({ title: "C", outLinks: { spotify: "https://open.spotify.com/track/1" }, externalIds: { itunes: "1" } }));
    const book = await insertItem(env.DB, itemDraft({ kind: "book", title: "D", outLinks: { youtube: "https://www.youtube.com/watch?v=1" } }));
    await env.DB.exec(migration.replace(/^--.*$/gm, "").replace(/\s*\n\s*/g, " ").trim());
    const kind = async (id: string) => (await env.DB.prepare("SELECT kind FROM items WHERE id = ?").bind(id).first<{ kind: string }>())!.kind;
    expect([await kind(byId.id), await kind(byLink.id), await kind(plain.id), await kind(book.id)]).toEqual(["video", "video", "music", "book"]);
  });
});
