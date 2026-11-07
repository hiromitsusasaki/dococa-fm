import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { get, newSession, postForm } from "../routes/helpers";

beforeEach(() => resetDb(env.DB));

describe("shared layout", () => {
  it("loads the two Google Fonts families and carries the retro-future header", async () => {
    const html = await (await get("/", await newSession())).text();
    expect(html).toMatch(/<link[^>]+fonts\.googleapis\.com[^>]+family=Righteous/);
    expect(html).toContain("family=Zen+Kaku+Gothic+New:wght@400;500;700");
    expect(html).toContain("display=swap");
    expect(html).toContain('class="site-header"');
    expect(html).toContain('<meta name="theme-color" content="#121a2e"');
  });

  it("offers light, dark and follow-device, in the listener's language", async () => {
    const html = await (await get("/", await newSession())).text();
    for (const mode of ["light", "dark", "auto"]) expect(html).toContain(`data-theme-set="${mode}"`);
    expect(html).toContain("ライト");
    expect(html).toContain("ダーク");
    expect(html).toContain("端末に合わせる");
  });

  it("reads the saved theme before paint, so there is no flash", async () => {
    const html = await (await get("/", await newSession())).text();
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain("dfm.theme");
  });

  it("has a language switch with the current language pressed and the page path to come back to", async () => {
    const cookie = await newSession();
    const ja = await (await get("/put", cookie)).text();
    const form = ja.match(/<form[^>]*class="lang-toggle"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain('action="/lang"');
    expect(form).toContain('name="next" value="/put"');
    expect(form.match(/<button/g)).toHaveLength(2);
    expect(form).toMatch(/<button[^>]*value="ja"[^>]*aria-pressed="true"/);
    expect(form).toMatch(/<button[^>]*value="en"[^>]*aria-pressed="false"/);
    expect(form).toContain("日本語");
    expect(form).toContain("English");
    await postForm("/lang", cookie, { lang: "en", next: "/put" });
    const en = await (await get("/put", cookie)).text();
    expect(en).toMatch(/<button[^>]*value="en"[^>]*aria-pressed="true"/);
    expect(en).toMatch(/<button[^>]*value="ja"[^>]*aria-pressed="false"/);
  });

  it("gives the language switch short labels and a confirm marker, for the client to ask before it stops the radio", async () => {
    const html = await (await get("/put", await newSession())).text();
    const form = html.match(/<form[^>]*class="lang-toggle"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toContain("data-confirm");
    expect(form).toContain('<span class="full" aria-hidden="true">日本語</span><span class="short" aria-hidden="true">JA</span>');
    expect(form).toContain('<span class="short" aria-hidden="true">EN</span>');
    // The button keeps its full name for assistive technology whichever label shows.
    expect(form).toMatch(/<button[^>]*value="en"[^>]*aria-label="English"/);
  });

  it("gives every theme button a short label for a phone: sun, moon and the device word", async () => {
    const html = await (await get("/put", await newSession())).text();
    const group = html.match(/<div class="theme-toggle"[\s\S]*?<\/div>/)?.[0] ?? "";
    for (const short of ["☀︎", "☾", "端末"]) expect(group).toContain(`<span class="short" aria-hidden="true">${short}</span>`);
    expect((group.match(/class="full"/g) ?? []).length).toBe(3);
  });
});
