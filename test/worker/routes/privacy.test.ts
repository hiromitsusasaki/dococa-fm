import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { BASE, get, newSession, postForm } from "./helpers";

beforeEach(() => resetDb(env.DB));

describe("GET /privacy", () => {
  it("is open without sign-in, in Japanese, with every section and the date", async () => {
    const res = await SELF.fetch(`${BASE}/privacy`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>プライバシーポリシー</h1>");
    for (const h of ["預かるもの", "使い道", "みんなに見えるもの", "Cookie と端末の保存", "AI に渡すもの", "ほかに通るところ", "消すには", "連絡先"]) {
      expect(html).toContain(`<h2>${h}</h2>`);
    }
    expect(html).toContain("メールアドレスやプロフィール画像は保存しません");
    expect(html).toContain("2026 年 11 月 8 日");
  });

  it("follows the listener's language", async () => {
    const cookie = await newSession();
    await postForm("/lang", cookie, { lang: "en", next: "/privacy" });
    const html = await (await get("/privacy", cookie)).text();
    expect(html).toContain("<h1>Privacy policy</h1>");
    expect(html).toContain("we do not store your email address");
  });

  it("is linked from the footer of ordinary pages, not from an embedded one", async () => {
    const home = await (await get("/", await newSession())).text();
    expect(home).toMatch(/<footer class="site-footer">\s*<a href="\/privacy"/);
    const embed = await (await get("/put?embed=1", await newSession())).text();
    expect(embed).not.toContain('href="/privacy"');
  });
});
