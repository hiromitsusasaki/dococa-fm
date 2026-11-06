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
  it("shows the tagline, the listen and put actions and the newest six public letters as cards", async () => {
    const cookie = await newSession();
    const seen = await insertItem(env.DB, itemDraft({ title: "聴いた曲", externalIds: { itunes: "999" } }));
    await upsertHistory(env.DB, [{ listenerId: cookie.split("=")[1]!.split(".")[0]!, itemId: seen.id, source: "manual", occurredAt: null, rank: null }]);
    const ids: string[] = [];
    const long = "あ".repeat(130);
    for (let i = 0; i < 7; i++) {
      const it = await insertItem(env.DB, itemDraft({ title: `作品${i}`, externalIds: { itunes: String(i) }, imageUrl: i === 3 ? null : "https://example.com/a.jpg" }));
      const l = await insertLetter(env.DB, letterDraft(it.id, { body: i === 6 ? long : `本文${i}`, bodyJa: i === 6 ? long : `本文${i}` }));
      ids.push(l.id);
      await new Promise((r) => setTimeout(r, 2));
    }
    const wm = await insertItem(env.DB, itemDraft({ title: "私もの作品", externalIds: { itunes: "w" } }));
    await insertLetter(env.DB, letterDraft(wm.id, { kind: "watashimo", body: "私も好き", bodyJa: "私も好き" }));
    await insertLetter(env.DB, letterDraft(wm.id, { status: "rejected", body: "弾かれた", bodyJa: "弾かれた" }));
    const res = await get("/", cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("世界のどこかにいる誰かの好きなものが聴こえてくるラジオ");
    expect(html).not.toMatch(/<form[^>]*action="\/episodes"/);
    expect(html).toContain('href="/stations/mine"');
    expect(html).toContain("あなたのラジオをつける");
    expect(html).toContain('href="/episodes"');
    expect(html).toMatch(/href="\/put"[^>]*>お便りを送る/);
    expect(html).toContain("いま届いているお便り");
    expect(html).not.toContain("最近の作品");
    expect((html.match(/class="letter-card"/g) ?? []).length).toBe(6);
    for (const id of ids.slice(1)) expect(html).toContain(`href="/stations/mine?letter=${id}"`);
    expect(html).not.toContain(`letter=${ids[0]}"`);
    expect(html).not.toContain("私も好き");
    expect(html).not.toContain("弾かれた");
    expect(html).toContain(`${"あ".repeat(120)}…`);
    expect(html).not.toContain("あ".repeat(121));
    expect(html).toContain("本文5");
    expect(html).toContain("作品5 · ラジオネームさん（札幌）");
    expect(html).toContain('<img src="https://example.com/a.jpg" alt="" width="96" height="96" loading="lazy"');
    expect(html).toContain("このお便りから聴く");
    expect(html).not.toMatch(/\d+\s*(件|人|位)/);
  });

  it("does not cut a letter of 120 code points or fewer, and leaves the art box empty without an image", async () => {
    const cookie = await newSession();
    const exact = "😀".repeat(120);
    const it = await insertItem(env.DB, itemDraft({ imageUrl: null }));
    await insertLetter(env.DB, letterDraft(it.id, { body: exact, bodyJa: exact }));
    const html = await (await get("/", cookie)).text();
    expect(html).toContain(`>${exact}<`);
    expect(html).toContain('<span class="letter-card-art"></span>');
  });

  it("a card has two links: the radio from the letter, and the work page; the viewer's own letter goes to the work page", async () => {
    const cookie = await newSession();
    const id = cookie.split("=")[1]!.split(".")[0]!;
    await get("/", cookie);
    const it = await insertItem(env.DB, itemDraft({ title: "曲B", externalIds: { itunes: "b" } }));
    const mine = await insertLetter(env.DB, letterDraft(it.id, { body: "自分の便り", bodyJa: "自分の便り", listenerId: id }));
    await new Promise((r) => setTimeout(r, 2));
    const other = await insertLetter(env.DB, letterDraft(it.id, { body: "ひとの便り", bodyJa: "ひとの便り" }));
    const html = await (await get("/", cookie)).text();
    expect(html).toContain(`<a class="letter-card-main" href="/stations/mine?letter=${other.id}">`);
    expect(html).toContain(`<a class="letter-card-main" href="/items/${it.id}">`);
    expect(html).not.toContain(`letter=${mine.id}`);
    expect((html.match(new RegExp(`<a class="letter-card-meta" href="/items/${it.id}">曲B`, "g")) ?? []).length).toBe(2);
    expect((html.match(/このお便りから聴く/g) ?? []).length).toBe(1);
    expect(html).not.toMatch(/<a\s[^>]*>(?:(?!<\/a>)[\s\S])*<a\s/);
  });

  it("shows a found voice with its source author, and only when it has one", async () => {
    const cookie = await newSession();
    const it = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(it.id, { kind: "found", body: "出典つきの声", bodyJa: "出典つきの声", sourceAuthor: "誰かの投稿", sourceUrl: "https://x.example/p", radioName: "", place: "" }));
    await insertLetter(env.DB, letterDraft(it.id, { kind: "found", body: "URL なしの声", bodyJa: "URL なしの声", sourceAuthor: "誰か", sourceUrl: "" }));
    await insertLetter(env.DB, letterDraft(it.id, { kind: "found", body: "出典なしの声", bodyJa: "出典なしの声", sourceAuthor: null }));
    const html = await (await get("/", cookie)).text();
    expect(html).toContain("出典つきの声");
    expect(html).toContain("出典: 誰かの投稿");
    expect(html).not.toContain("出典なしの声");
    expect(html).not.toContain("URL なしの声");
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
