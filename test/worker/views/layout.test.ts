import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { get, newSession } from "../routes/helpers";

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
});
