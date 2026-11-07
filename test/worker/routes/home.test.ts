import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { resetDb } from "../../helpers/db";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener, updateListener } from "../../../src/worker/db/listeners";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { recordListen } from "../../../src/worker/db/listens";
import type { Episode } from "../../../src/worker/types";
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
    expect(html).not.toContain("あなたのラジオをつける");
    // Nothing heard yet: no archive link either.
    expect(html).not.toContain('href="/episodes"');
    expect(html).toMatch(/href="\/put"[^>]*>お便りを送る/);
    // The radio's script puts the send button above the on-air list; the page only asks for it.
    expect(html).toContain('data-send="1"');
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
    // The link stays for a new tab and for no script; the station script plays the letter on the home radio.
    expect(html).toContain(`<a class="letter-card-main" href="/stations/mine?letter=${other.id}" data-play-letter="${other.id}">`);
    expect(html).toContain(`<a class="letter-card-main" href="/items/${it.id}">`);
    // The play mark is decoration on the cards that play; the viewer's own card has none.
    expect((html.match(/<span class="letter-card-playmark" aria-hidden="true"><\/span>/g) ?? []).length).toBe((html.match(/data-play-letter="/g) ?? []).length);
    expect(html).not.toContain(`letter=${mine.id}`);
    expect(html).not.toContain(`data-play-letter="${mine.id}"`);
    expect((html.match(new RegExp(`<a class="letter-card-meta" href="/items/${it.id}">曲B`, "g")) ?? []).length).toBe(2);
    // Outside the radio's strings (its primed switch says the same words).
    expect((html.replace(/<script[\s\S]*?<\/script>/g, "").match(/このお便りから聴く/g) ?? []).length).toBe(1);
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

  it("explains that three letters lean the radio to the listener's taste, with no link to /start, for every listener", async () => {
    const cookie = await newSession();
    const explain = '<p class="muted">お便りを 3 通送ると、あなたの好みに近いお便りが流れてきます。</p>';
    const html = await (await get("/", cookie)).text();
    expect(html).toContain(explain);
    expect(html).not.toContain('href="/start"');
    expect(html).not.toContain("あなたのラジオをつける");
    const en = await (await SELF.fetch(`${BASE}/`, { headers: { "accept-language": "en" } })).text();
    expect(en).toContain('<p class="muted">Send 3 letters and the radio plays letters closer to your taste.</p>');
    expect(en).not.toContain('href="/start"');
  });

  it("locks the dial until the listener has three own letters and reactions; favourites do not count", async () => {
    const cookie = await newSession();
    const me = cookie.split("=")[1]!.split(".")[0]!;
    const other = await createListener(env.DB);
    const it = await insertItem(env.DB, itemDraft());
    for (const n of [1, 2, 3]) await upsertHistory(env.DB, [{ listenerId: me, itemId: (await insertItem(env.DB, itemDraft({ title: `fav${n}`, externalIds: { itunes: `f${n}` } }))).id, source: "manual", occurredAt: null, rank: n }]);
    expect(await (await get("/", cookie)).text()).toContain('data-dial-ready="0"');
    await insertLetter(env.DB, letterDraft(it.id, { listenerId: me, body: "one" }));
    const theirs = await insertLetter(env.DB, letterDraft(it.id, { listenerId: other.id, body: "theirs" }));
    await insertLetter(env.DB, letterDraft(it.id, { kind: "reply", listenerId: me, parentLetterId: theirs.id, body: "yes" }));
    expect(await (await get("/", cookie)).text()).toContain('data-dial-ready="0"');
    await insertLetter(env.DB, letterDraft(it.id, { kind: "watashimo", listenerId: me, parentLetterId: theirs.id }));
    expect(await (await get("/", cookie)).text()).toContain('data-dial-ready="1"');
  });

  it("lists the three latest programmes the listener heard, by work and sender, then the archive link; a new listener gets the link only", async () => {
    const cookie = await newSession();
    const listenerId = cookie.split("=")[1]!.split(".")[0]!;
    await get("/", cookie);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const it = await insertItem(env.DB, itemDraft({ title: `番組の曲${i}`, externalIds: { itunes: `e${i}` } }));
      const l = await insertLetter(env.DB, letterDraft(it.id, { body: `便り${i}`, bodyJa: `便り${i}` }));
      const line = { type: "letter" as const, letterId: l.id, text: l.body, radioName: `送り主${i}`, place: "札幌", kind: "letter" as const, sourceUrl: null, sourceAuthor: null };
      const ep = await insertEpisode(env.DB, { listenerId, segments: [{ itemId: it.id, slot: "near" as const, lines: [{ type: "dj" as const, text: "x" }, line] }], verified: true, report: {} as Episode["report"], createdAt: `2026-11-0${i + 1}T00:00:00.000Z` });
      await recordListen(env.DB, { listenerId, episodeId: ep.id, letterId: l.id, segmentIndex: 0 });
      ids.push(ep.id);
    }
    const html = await (await get("/", cookie)).text();
    const section = html.slice(html.indexOf('<section class="panel recent-episodes">'), html.indexOf("</section>", html.indexOf('<section class="panel recent-episodes">')));
    // A panel like the others: the rounded frame and its gradient rule (`.panel`), then the heading.
    expect(section).toContain("<h2>これまでの番組</h2>");
    // The rows are the on-air list's: the same classes in the same order, the whole row one link.
    expect(section).toContain('<ul class="up-next">');
    expect(section).toContain(`<li><a class="row-link" href="/episodes/${ids[3]}">`);
    expect(section).toContain('<span class="kind">音楽</span><span class="title">番組の曲3</span><span class="creator">');
    expect(section).toContain('<span class="sender">送り主3さん（札幌）</span>');
    expect(section).toContain(`href="/episodes/${ids[1]}"`);
    expect(section).not.toContain(ids[0]);
    expect(section).not.toContain("<h3");
    expect(section.match(/<li>/g)).toHaveLength(3);
    expect(section.indexOf(ids[3]!)).toBeLessThan(section.indexOf(ids[2]!));
    expect(section).toContain('<a href="/episodes">すべて見る</a>');
    expect(section).not.toMatch(/\d+\s*(件|人|位|回)/);

    // A listener who has heard nothing gets no section: no heading and no link to an empty archive.
    const fresh = await (await get("/", await newSession())).text();
    expect(fresh).not.toContain("recent-episodes");
    expect(fresh).not.toContain("これまでの番組");
    expect(fresh).not.toContain('href="/episodes"');
  });

  it("shows the work's picture on a programme row when it has one, and no picture element when it has none", async () => {
    const cookie = await newSession();
    const listenerId = cookie.split("=")[1]!.split(".")[0]!;
    await get("/", cookie);
    const withArt = await insertItem(env.DB, itemDraft({ title: "絵のある曲", externalIds: { itunes: "pa" }, imageUrl: "https://example.com/p.jpg" }));
    const noArt = await insertItem(env.DB, itemDraft({ title: "絵のない曲", externalIds: { itunes: "pb" }, imageUrl: null }));
    for (const [n, it] of [withArt, noArt].entries()) {
      const l = await insertLetter(env.DB, letterDraft(it.id, { body: "便り", bodyJa: "便り" }));
      const line = { type: "letter" as const, letterId: l.id, text: "便り", radioName: "送り主", place: "札幌", kind: "letter" as const, sourceUrl: null, sourceAuthor: null };
      const ep = await insertEpisode(env.DB, { listenerId, segments: [{ itemId: it.id, slot: "near" as const, lines: [line] }], verified: true, report: {} as Episode["report"], createdAt: `2026-11-0${n + 1}T00:00:00.000Z` });
      await recordListen(env.DB, { listenerId, episodeId: ep.id, letterId: l.id, segmentIndex: 0 });
    }
    const html = await (await get("/", cookie)).text();
    const rows = [...html.matchAll(/<li><a class="row-link"[\s\S]*?<\/a><\/li>/g)].map((m) => m[0]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('<img class="thumb" src="https://example.com/p.jpg" alt="" width="40" height="40"');
    expect(rows[0]).not.toContain("<img");
  });

  it("names the letter's sender in a recent programme, never someone who replied to it", async () => {
    const cookie = await newSession();
    const listenerId = cookie.split("=")[1]!.split(".")[0]!;
    const it = await insertItem(env.DB, itemDraft({ title: "返信のある曲", externalIds: { itunes: "rp" } }));
    const l = await insertLetter(env.DB, letterDraft(it.id, { body: "便り", bodyJa: "便り" }));
    const r = await insertLetter(env.DB, letterDraft(it.id, { kind: "reply", parentLetterId: l.id, body: "いいね", bodyJa: "いいね" }));
    const reply = { type: "letter" as const, letterId: r.id, text: "いいね", radioName: "返した人", place: "那覇", kind: "reply" as const, sourceUrl: null, sourceAuthor: null };
    const letter = { type: "letter" as const, letterId: l.id, text: "便り", radioName: "送り主", place: "札幌", kind: "letter" as const, sourceUrl: null, sourceAuthor: null };
    const both = await insertEpisode(env.DB, { listenerId, segments: [{ itemId: it.id, slot: "near" as const, lines: [reply, letter] }], verified: true, report: {} as Episode["report"], createdAt: "2026-11-02T00:00:00.000Z" });
    const only = await insertEpisode(env.DB, { listenerId, segments: [{ itemId: it.id, slot: "near" as const, lines: [{ type: "dj" as const, text: "x" }, reply] }], verified: true, report: {} as Episode["report"], createdAt: "2026-11-01T00:00:00.000Z" });
    await recordListen(env.DB, { listenerId, episodeId: both.id, letterId: l.id, segmentIndex: 0 });
    await recordListen(env.DB, { listenerId, episodeId: only.id, letterId: r.id, segmentIndex: 0 });
    const html = await (await get("/", cookie)).text();
    const row = (id: string) => html.match(new RegExp(`<li><a class="row-link" href="/episodes/${id}">[\\s\\S]*?</a></li>`))?.[0] ?? "";
    expect(row(both.id)).toContain('<span class="sender">送り主さん（札幌）</span>');
    expect(row(only.id)).toContain("返信のある曲");
    expect(row(only.id)).not.toContain('class="sender"');
    expect(html).not.toContain("返した人");
  });

  it.each(["withdrawn", "rejected"] as const)("leaves a %s letter's sender out of the recent programmes, and drops a row it was the only letter of", async (status) => {
    const cookie = await newSession();
    const listenerId = cookie.split("=")[1]!.split(".")[0]!;
    const it = await insertItem(env.DB, itemDraft({ title: "消えた便りの曲", externalIds: { itunes: "wd" } }));
    const gone = await insertLetter(env.DB, letterDraft(it.id, { body: "便り", bodyJa: "便り" }));
    const kept = await insertLetter(env.DB, letterDraft(it.id, { body: "残る便り", bodyJa: "残る便り" }));
    const line = (id: string, radioName: string) => ({ type: "letter" as const, letterId: id, text: "便り", radioName, place: "札幌", kind: "letter" as const, sourceUrl: null, sourceAuthor: null });
    const alone = await insertEpisode(env.DB, { listenerId, segments: [{ itemId: it.id, slot: "near" as const, lines: [line(gone.id, "消えた人")] }], verified: true, report: {} as Episode["report"], createdAt: "2026-11-01T00:00:00.000Z" });
    const two = await insertEpisode(env.DB, { listenerId, segments: [{ itemId: it.id, slot: "near" as const, lines: [line(gone.id, "消えた人"), line(kept.id, "残る人")] }], verified: true, report: {} as Episode["report"], createdAt: "2026-11-02T00:00:00.000Z" });
    await recordListen(env.DB, { listenerId, episodeId: alone.id, letterId: gone.id, segmentIndex: 0 });
    await recordListen(env.DB, { listenerId, episodeId: two.id, letterId: kept.id, segmentIndex: 0 });
    await env.DB.prepare("UPDATE letters SET status = ? WHERE id = ?").bind(status, gone.id).run();
    for (const path of ["/", "/episodes"]) {
      const html = await (await get(path, cookie)).text();
      expect(html, path).not.toContain(`/episodes/${alone.id}`);
      const row = html.match(new RegExp(`<a[^>]*href="/episodes/${two.id}"[\\s\\S]*?</a>`))?.[0] ?? "";
      expect(row, path).toContain("消えた便りの曲");
      expect(row, path).not.toContain('class="sender"');
      expect(html, path).not.toContain("消えた人");
    }
  });

  it("orders the home: the radio, the send dialog, explanation, recent programmes, then the letter cards", async () => {
    const cookie = await newSession();
    const listenerId = cookie.split("=")[1]!.split(".")[0]!;
    await get("/", cookie);
    const it = await insertItem(env.DB, itemDraft());
    const l = await insertLetter(env.DB, letterDraft(it.id, { body: "順番の便り", bodyJa: "順番の便り" }));
    const line = { type: "letter" as const, letterId: l.id, text: "順番の便り", radioName: "送り主", place: "札幌", kind: "letter" as const, sourceUrl: null, sourceAuthor: null };
    const ep = await insertEpisode(env.DB, { listenerId, segments: [{ itemId: it.id, slot: "near" as const, lines: [line] }], verified: true, report: {} as Episode["report"] });
    await recordListen(env.DB, { listenerId, episodeId: ep.id, letterId: l.id, segmentIndex: 0 });
    const html = await (await get("/", cookie)).text();
    const at = (s: string) => {
      const i = html.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const order = [at('id="station"'), at('<section class="home">'), at('<dialog class="send-modal"'), at('<p class="muted">お便りを 3 通送ると'), at('<section class="panel recent-episodes">'), at('class="letter-cards"')];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("is the listener's own radio, with the dial: tuning in needs no registration", async () => {
    const cookie = await newSession();
    const html = await (await get("/", cookie)).text();
    expect(html).toContain('id="station"');
    expect(html).toContain('data-station-key="mine"');
    expect(html).toContain('data-next-url="/stations/mine/next"');
    expect(html).toContain('data-resume-url="/stations/mine.json"');
    // The player shows the dial on `mine` only (station.test.ts); the page hands it the listener's value.
    expect(html).toMatch(/data-dial="[0-9.]+"/);
    expect(html).toContain('data-grow="0"');
    expect(html).toContain('id="station-i18n"');
    const page = html.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(page.match(/<h1/g)).toHaveLength(1);
    expect(page).not.toContain("tune-in");
    expect(html).toMatch(/id="station-i18n"[^>]*>[^<]*"station\.on":"ラジオをつける"/);
    expect(html).toContain("<title>Dococa FM</title>");
  });

  it("sends a letter from a modal: a /put link the station script opens as a dialog, whose frame loads only when opened", async () => {
    const html = await (await get("/", await newSession())).text();
    // The button itself is drawn by the radio's script, in the send panel over the on-air panel (station.test.ts).
    expect(html).not.toContain("data-open-send");
    expect(html).toMatch(/"home\.put":"お便りを送る"/);
    expect(html).toContain('"home.sendLead":"好きな曲・本・映画について、200 字まで。DJ が読み上げます。"');
    // The share links on the now-playing card are drawn by the same script.
    expect(html).toMatch(/"share\.x":"X で共有","share\.native":"共有","share\.text":"\{work\} · \{sender\}のお便り — Dococa FM"/);
    expect(html).toMatch(/<dialog class="send-modal" aria-label="お便りを送る"><form method="dialog" class="send-modal-bar"><button type="submit" class="quiet">閉じる<\/button><\/form><iframe data-src="\/put\?embed=1" title="お便りを送る"><\/iframe><\/dialog>/);
    expect(html).not.toMatch(/\ssrc="\/put\?embed=1"/);
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

  it("shows the short hero from the second visit on: a script right after the hero reads dfm.seen before paint", async () => {
    const html = await (await get("/", await newSession())).text();
    const hero = html.indexOf('<section class="hero">');
    const after = html.slice(html.indexOf("</section>", hero), html.indexOf('id="station"'));
    expect(after).toContain('localStorage.getItem("dfm.seen")');
    expect(after).toContain('classList.add("compact")');
  });

  it("links to no world station anywhere on screen", async () => {
    const cookie = await newSession();
    const page = (await (await get("/", cookie)).text()).replace(/<script[\s\S]*?<\/script>/g, "");
    expect(page).not.toContain("/stations/world");
  });
});

describe("GET /?letter=", () => {
  it("primes the home radio with someone else's public letter, and keeps it in the language switch's return path", async () => {
    const cookie = await newSession();
    const it = await insertItem(env.DB, itemDraft({ title: "届いた曲", externalIds: { itunes: "pr1" } }));
    const l = await insertLetter(env.DB, letterDraft(it.id));
    const html = await (await get(`/?letter=${l.id}`, cookie)).text();
    expect(html).toMatch(new RegExp(`<div[^>]*id="station"[^>]*data-letter="${l.id}"`));
    expect(html).toContain('data-station-key="mine"');
    expect(html).toContain(`<input type="hidden" name="next" value="/?letter=${l.id}"`);
    expect(await (await get("/", cookie)).text()).not.toContain("data-letter");
    expect(await (await get(`/?letter=${"x".repeat(101)}`, cookie)).text()).not.toContain("data-letter");
    expect(await (await get("/?letter=", cookie)).text()).not.toContain("data-letter");
  });

  it("renders the ordinary home for the viewer's own letter, a letter no longer public, a reaction or an unknown id", async () => {
    const cookie = await newSession();
    const me = cookie.split("=")[1]!.split(".")[0]!;
    await get("/", cookie);
    const it = await insertItem(env.DB, itemDraft({ title: "届かない曲", externalIds: { itunes: "pr2" } }));
    const own = await insertLetter(env.DB, letterDraft(it.id, { listenerId: me }));
    const withdrawn = await insertLetter(env.DB, letterDraft(it.id, { status: "withdrawn" }));
    const rejected = await insertLetter(env.DB, letterDraft(it.id, { status: "rejected" }));
    const parent = await insertLetter(env.DB, letterDraft(it.id));
    const reply = await insertLetter(env.DB, letterDraft(it.id, { kind: "reply", parentLetterId: parent.id, body: "一言", bodyJa: "一言" }));
    for (const id of [own.id, withdrawn.id, rejected.id, reply.id, "abc-123"]) {
      const html = await (await get(`/?letter=${id}`, cookie)).text();
      expect(html, id).not.toContain("data-letter");
      expect(html, id).toContain('<input type="hidden" name="next" value="/"');
    }
  });

  it("previews a public letter with its work's title and the letter's first 80 characters", async () => {
    const cookie = await newSession();
    const it = await insertItem(env.DB, itemDraft({ title: "雨の日の曲", externalIds: { itunes: "og1" } }));
    const body = "い".repeat(79) + "ろは";
    const l = await insertLetter(env.DB, letterDraft(it.id, { body, bodyJa: body }));
    const html = await (await get(`/?letter=${l.id}`, cookie)).text();
    expect(html).toContain('<meta property="og:title" content="雨の日の曲"');
    expect(html).toContain(`<meta property="og:description" content="${"い".repeat(79)}ろ"`);
    expect(html).toContain(`<meta property="og:url" content="http://127.0.0.1:5173/?letter=${l.id}"`);
  });

  it("previews nothing for a letter that is not public, a reaction, or no letter at all", async () => {
    const cookie = await newSession();
    const it = await insertItem(env.DB, itemDraft({ title: "隠れた曲", externalIds: { itunes: "og2" } }));
    const hidden = await insertLetter(env.DB, letterDraft(it.id, { status: "rejected", body: "見せない", bodyJa: "見せない" }));
    const parent = await insertLetter(env.DB, letterDraft(it.id));
    const reply = await insertLetter(env.DB, letterDraft(it.id, { kind: "reply", parentLetterId: parent.id, body: "一言", bodyJa: "一言" }));
    for (const id of [hidden.id, reply.id, "nope"]) {
      const html = await (await get(`/?letter=${id}`, cookie)).text();
      expect(html).not.toContain("og:title");
      expect(html).not.toContain("data-letter");
    }
    expect(await (await get("/", cookie)).text()).not.toContain("og:title");
  });
});

describe("GET / public radios", () => {
  const radio = async (slug: string, over: Parameters<typeof updateListener>[2] = {}) =>
    (await updateListener(env.DB, (await createListener(env.DB)).id, { stationSlug: slug, stationPublic: true, radioName: `${slug}ラジオ`, place: "札幌", ...over }))!;

  it("lists up to 5 public radios with new letters, newest first, as a name and a place linked to the station, without a number", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const slugs = ["r1", "r2", "r3", "r4", "r5", "r6"];
    for (const slug of slugs) {
      const l = await radio(slug, slug === "r2" ? { placeCountry: "JP", placeRegion: "47" } : {});
      await insertLetter(env.DB, letterDraft(item.id, { listenerId: l.id }));
      await new Promise((r) => setTimeout(r, 3));
    }
    const priv = await radio("hidden", { stationPublic: false });
    await insertLetter(env.DB, letterDraft(item.id, { listenerId: priv.id }));
    const html = await (await get("/", await newSession())).text();
    const section = html.slice(html.indexOf('class="public-radios"'));
    const end = section.indexOf("</section>");
    const block = section.slice(0, end);
    expect(block).toContain("お便りが届いた公開ラジオ");
    const hrefs = [...block.matchAll(/href="(\/stations\/s:[^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/stations/s:r6", "/stations/s:r5", "/stations/s:r4", "/stations/s:r3", "/stations/s:r2"]);
    expect(block).toContain("r6ラジオ");
    expect(block).toContain("沖縄");
    expect(block).not.toContain("hidden");
    expect(block).not.toContain("r1ラジオ");
    expect(block).not.toMatch(/\d+ ?(件|通)/);
    // Between the recent programmes and the letter cards.
    expect(html.indexOf('class="public-radios"')).toBeGreaterThan(html.indexOf('class="home"'));
  });

  it("is left out when no public radio has a letter, and a withdrawn letter does not count", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const l = await radio("quiet");
    await insertLetter(env.DB, letterDraft(item.id, { listenerId: l.id, status: "withdrawn" }));
    await radio("empty");
    const html = await (await get("/", await newSession())).text();
    expect(html).not.toContain("public-radios");
    expect(html).not.toContain("お便りが届いた公開ラジオ");
  });
});
