import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { BASE, get, newSession, postForm } from "./helpers";

beforeEach(() => resetDb(env.DB));

describe("GET /about", () => {
  it("answers in Japanese with a title, a lead and the four sections", async () => {
    const res = await get("/about", await newSession());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Dococa FM とは</h1>");
    expect(html).toContain("世界のどこかにいる誰かの好きなものが聴こえてくるラジオです。");
    for (const h of ["聴く", "送る", "自分のラジオ", "できること・しないこと"]) expect(html).toContain(`<h2>${h}</h2>`);
    expect((html.match(/<section class="panel/g) ?? []).length).toBe(4);
    expect(html).not.toContain("局");
  });

  it("carries the gradient rule under each heading, not on top of the panel", async () => {
    const html = await (await get("/about", await newSession())).text();
    expect((html.match(/<section class="panel panel-rule-under/g) ?? []).length).toBe(4);
    expect((html.match(/<\/h2>\s*<div class="rule"/g) ?? []).length).toBe(4);
    expect((html.match(/class="rule"/g) ?? []).length).toBe(4);
    const css = await (await SELF.fetch(`${BASE}/app.css`)).text();
    expect(css).toMatch(/\.panel-rule-under::before\s*{\s*display:\s*none/);
  });

  it("says the own radio leans to the listener after three letters, keeps the sign-in line, and links neither /start nor Spotify", async () => {
    const ja = await (await get("/about", await newSession())).text();
    expect(ja).toMatch(/<h2>自分のラジオ<\/h2>[\s\S]*?<p>自分のラジオは、あなたが送ったお便りと、「一言」を返したお便りをまとめたラジオです。Google でサインインして/);
    expect(ja).not.toContain("好きなものを 3 つ");
    expect(ja).not.toContain('href="/start"');
    expect(ja).not.toMatch(/href="\/auth\/spotify|href="\/settings\/spotify/);
    const cookie = await newSession();
    await postForm("/lang", cookie, { lang: "en", next: "/about" });
    const en = await (await get("/about", cookie)).text();
    expect(en).toMatch(/<p>Your radio gathers the letters you sent and the letters you replied to\. Sign in with Google/);
  });

  it("goes from the lead straight to the sections, with no section about why it was made", async () => {
    const html = await (await get("/about", await newSession())).text();
    expect(html).not.toContain("about-why");
    expect(html).not.toContain("なぜ作ったか");
    expect(html.indexOf('class="about-lead"')).toBeLessThan(html.indexOf("/about/listen.jpg"));
  });

  it("tells a listener they do not have to reply", async () => {
    const html = await (await get("/about", await newSession())).text();
    expect(html).toMatch(/<h2>聴く<\/h2>[\s\S]*?共感のリアクション（「私も」）やコメント（「一言」）を返すことができます。<\/p>/);
  });

  it("offers the home's tour again, through /?tour=1", async () => {
    const html = await (await get("/about", await newSession())).text();
    expect(html).toMatch(/<a class="pill tour-again" href="\/\?tour=1">使い方<\/a>\s*<small class="muted">ホームに戻って、画面の案内を順に表示します<\/small>/);
  });

  it("opens with the key visual under the title", async () => {
    const html = await (await get("/about", await newSession())).text();
    expect(html).toMatch(/<h1>[^<]*<\/h1>\s*<figure class="about-kv"><picture><source media="\(max-width: 760px\)" srcset="\/kv-mobile\.jpg"\/?><img src="\/kv\.jpg" alt="[^"]+" width="1280" height="853"/);
    expect(html.indexOf("/kv.jpg")).toBeLessThan(html.indexOf('class="about-lead"'));
  });

  it("puts one illustration in each section", async () => {
    const html = await (await get("/about", await newSession())).text();
    for (const name of ["listen", "send", "mine", "rules"]) {
      expect(html).toMatch(new RegExp(`<img src="/about/${name}\\.jpg" alt="[^"]+" width="1280" height="720"`));
    }
  });

  it("opens the rules with what the AI never does", async () => {
    const ja = await (await get("/about", await newSession())).text();
    expect(ja).toMatch(/<h2>できること・しないこと<\/h2>\s*<div class="rule"[^>]*><\/div>\s*<figure[^>]*>.*?<\/figure>\s*<p>お便りはそれを書いた人のものなので、書き足しも言い換えもせずにそのまま紹介されます。DJ は、あなたが好きかもしれないものと、まだ出会ったことのない新しいものへのお便りを、ダイヤルで選んだバランスで、あなただけに紹介します。<\/p>/);
    const cookie = await newSession();
    await postForm("/lang", cookie, { lang: "en", next: "/about" });
    const en = await (await get("/about", cookie)).text();
    expect(en).toMatch(/<h2>What we do and don[^<]*t do<\/h2>\s*<div class="rule"[^>]*><\/div>\s*<figure[^>]*>.*?<\/figure>\s*<p>A letter belongs to the person who wrote it, so it is introduced exactly as written, without adding or rewording anything\. The DJ introduces, to you alone, letters about things you might love and things you have never met, in the balance you choose with the dial\.<\/p>/);
  });

  it("answers in English for an English listener", async () => {
    const cookie = await newSession();
    await postForm("/lang", cookie, { lang: "en", next: "/about" });
    const html = await (await get("/about", cookie)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<h1>About Dococa FM</h1>");
    expect((html.match(/<section class="panel/g) ?? []).length).toBe(4);
    expect(html).toContain("<h2>Listen</h2>");
    expect(html).not.toContain("聴く");
  });

  it("follows Accept-Language when the listener has no cookie yet", async () => {
    const html = await (await SELF.fetch(`${BASE}/about`, { headers: { "accept-language": "en-US,en;q=0.9" } })).text();
    expect(html).toContain("<h1>About Dococa FM</h1>");
  });
});

describe("the header's about link", () => {
  it("shows on the home before the send link", async () => {
    const html = await (await get("/", await newSession())).text();
    const about = html.indexOf('<a href="/about">Dococa FM とは</a>');
    expect(about).toBeGreaterThan(-1);
    expect(about).toBeLessThan(html.indexOf('<a href="/put">お便りを送る</a>'));
  });

  it("is marked as the current page on /about", async () => {
    const html = await (await get("/about", await newSession())).text();
    expect(html).toContain('<a href="/about" aria-current="page">Dococa FM とは</a>');
  });
});
