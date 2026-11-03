import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "./helpers";

describe("resetDb", () => {
  it("clears a chain of rows linked by foreign keys (item -> letter -> report) without error", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const letter = await insertLetter(env.DB, letterDraft(item.id));
    await env.DB.prepare("INSERT INTO reports (letter_id, listener_id, reason, created_at) VALUES (?, NULL, 'x', 'now')")
      .bind(letter.id)
      .run();
    await env.DB.prepare("INSERT INTO takedowns (url, reason, created_at) VALUES ('https://x', 'y', 'now')").run();

    await resetDb(env.DB);

    for (const t of ["reports", "takedowns", "letters", "items"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>();
      expect(row!.n, t).toBe(0);
    }
  });
});
