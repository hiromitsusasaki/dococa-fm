import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { resetDb } from "../../helpers/db";
import { insertLetter } from "../../../src/worker/db/letters";
import { itemDraft, letterDraft } from "../db/helpers";
import { BASE, get, newSession } from "./helpers";
import { SELF } from "cloudflare:test";

beforeEach(() => resetDb(env.DB));

describe("GET /", () => {
  it("shows the tagline, the listen and put actions and the newest six items", async () => {
    // The oldest item, so it falls outside the newest six.
    const cookie = await newSession();
    const seen = await insertItem(env.DB, itemDraft({ title: "聴いた曲", externalIds: { itunes: "999" } }));
    await upsertHistory(env.DB, [{ listenerId: cookie.split("=")[1]!.split(".")[0]!, itemId: seen.id, source: "manual", occurredAt: null, rank: null }]);
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
    expect(html).not.toMatch(/<form[^>]*action="\/episodes"/);
    expect(html).toContain('href="/stations/mine"');
    expect(html).toContain("あなたのラジオをつける");
    expect(html).toContain('href="/episodes"');
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
    const first = await (await get("/", cookie)).text();
    expect(first).toContain('href="/start"');
    expect(first).toContain("好きなものを 3 つ送って、あなたのラジオを始める");
    expect(first).not.toContain('href="/stations/mine"');
    const item = await insertItem(env.DB, itemDraft());
    const id = cookie.split("=")[1]!.split(".")[0]!;
    await upsertHistory(env.DB, [{ listenerId: id, itemId: item.id, source: "manual", occurredAt: null, rank: null }]);
    const html = await (await get("/", cookie)).text();
    expect(html).not.toContain('href="/start"');
    expect(html).toContain("あなたのラジオをつける");
  });

  it("is the world station: tuning in needs no registration", async () => {
    const cookie = await newSession();
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('id="station"');
    expect(html).toContain('data-station-key="world"');
    expect(html).toContain('data-next-url="/stations/world/next"');
    expect(html).toContain('data-grow="0"');
    expect(html).toContain('id="station-i18n"');
    const page = html.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).not.toContain("tune-in");
    expect(html).toMatch(/id="station-i18n"[^>]*>[^<]*"station\.on":"ラジオをつける"/);
    expect(html).toContain("<title>Dococa FM</title>");
  });

  it("opens with the hero: wordmark h1, tagline and the key visual with its alt", async () => {
    const html = await (await get("/", await newSession())).text();
    expect(html).toContain('class="hero"');
    expect(html).toMatch(/<h1 class="wordmark">Dococa FM<\/h1>/);
    expect(html).toContain('src="/kv.jpg"');
    expect(html).toContain('<source media="(max-width: 760px)" srcset="/kv-mobile.jpg"');
    expect(html).toContain('alt="机でレトロなラジオを聴く人と、世界の誰かの好きなもの"');
    expect(html.indexOf('class="hero"')).toBeLessThan(html.indexOf('id="station"'));
    // The tagline lives in the hero only.
    expect(html.match(/世界のどこかにいる誰かの好きなものが聴こえてくるラジオ/g)).toHaveLength(1);
  });

  it("has an English alt for an English listener", async () => {
    const res = await SELF.fetch(`${BASE}/`, { headers: { "accept-language": "en-US,en;q=0.9" } });
    expect(await res.text()).toContain('alt="Someone listening to a vintage radio at a desk, and what people around the world love"');
  });

  it("other stations have no hero", async () => {
    const html = await (await get("/stations/world", await newSession())).text();
    expect(html).not.toContain('class="hero"');
    expect(html).toContain('class="station-name"');
  });
});
