import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { resetDb } from "../../helpers/db";
import { insertLetter } from "../../../src/worker/db/letters";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, newSession } from "./helpers";

beforeEach(() => resetDb(env.DB));

describe("GET /", () => {
  it("shows the tagline, the listen and put actions and the newest six items", async () => {
    // The oldest item, so it falls outside the newest six.
    const cookie = await newSession();
    const seen = await insertItem(env.DB, itemDraft({ title: "聴いた曲", externalIds: { itunes: "999" } }));
    await upsertHistory(env.DB, [{ listenerId: cookie.split("=")[1]!.split(".")[0]!, itemId: seen.id, source: "manual", occurredAt: null }]);
    await new Promise((r) => setTimeout(r, 2));
    for (let i = 0; i < 7; i++) {
      const it = await insertItem(env.DB, itemDraft({ title: `作品${i}`, externalIds: { itunes: String(i) } }));
      await insertLetter(env.DB, letterDraft(it.id));
      await new Promise((r) => setTimeout(r, 2));
    }
    const res = await get("/", cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("世界のどこかにいる誰かの好きなものが聴こえてくるラジオ");
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/episodes"/);
    expect(html).toContain("あなたのラジオをつける");
    expect(html).toMatch(/href="\/put"[^>]*>お便りを送る/);
    expect(html).toContain("最近の作品");
    expect(html).toContain("作品6");
    expect(html).toContain("作品1<");
    expect(html).not.toContain("作品0<");
    expect(html).toMatch(/href="\/items\/[0-9a-f-]{36}"/);
    expect(html).not.toMatch(/\d+\s*(件|人|位)/);
  });

  it("hints at /start for a listener with no history and no letters, and not otherwise", async () => {
    const cookie = await newSession();
    expect(await (await get("/", cookie)).text()).toContain('href="/start"');
    const item = await insertItem(env.DB, itemDraft());
    const id = cookie.split("=")[1]!.split(".")[0]!;
    await upsertHistory(env.DB, [{ listenerId: id, itemId: item.id, source: "manual", occurredAt: null }]);
    const html = await (await get("/", cookie)).text();
    expect(html).not.toContain('href="/start"');
    expect(html).toContain("あなたのラジオをつける");
  });
});
