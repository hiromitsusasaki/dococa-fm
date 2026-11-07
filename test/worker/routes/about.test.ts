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

  it("answers in English for an English listener", async () => {
    const cookie = await newSession();
    await postForm("/lang", cookie, { lang: "en", next: "/about" });
    const html = await (await get("/about", cookie)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<h1>About Dococa FM</h1>");
    expect((html.match(/<section class="panel/g) ?? []).length).toBe(4);
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
