import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, newSession, postForm, signedInSession } from "../routes/helpers";

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

describe("the header's notice of new reactions", () => {
  const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;
  const meLink = (html: string) => html.match(/<a href="\/me"[\s\S]*?<\/a>/)?.[0] ?? "";
  const tick = () => new Promise((r) => setTimeout(r, 3));

  async function letterBy(listenerId: string) {
    const it = await insertItem(env.DB, itemDraft({ title: `w-${crypto.randomUUID()}`, externalIds: { itunes: crypto.randomUUID() } }));
    return insertLetter(env.DB, letterDraft(it.id, { listenerId }));
  }
  const react = (parent: { id: string; itemId: string }, over: Parameters<typeof letterDraft>[1] = {}) =>
    insertLetter(env.DB, letterDraft(parent.itemId, { kind: "watashimo", parentLetterId: parent.id, body: "私も", bodyJa: "私も", ...over }));

  it("shows a dot, never a number, on the /me link when someone reacted to the listener's letter", async () => {
    const cookie = await signedInSession();
    const mine = await letterBy(idOf(cookie));
    expect(meLink(await (await get("/", cookie)).text())).not.toContain("dot");
    const other = await createListener(env.DB);
    await react(mine, { listenerId: other.id });
    await react(mine, { listenerId: other.id, kind: "reply", body: "わかる", bodyJa: "わかる" });
    const link = meLink(await (await get("/put", cookie)).text());
    expect(link).toMatch(/<span class="dot" role="img" aria-label="新しい反応があります"><\/span>/);
    expect(link.replace(/<[^>]+>/g, "")).toBe("マイページ");
    expect(link).not.toMatch(/\d/);
  });

  it("clears only when the listener opens /me, and comes back with a later reaction", async () => {
    const cookie = await signedInSession();
    const mine = await letterBy(idOf(cookie));
    await react(mine);
    expect(meLink(await (await get("/", cookie)).text())).toContain('class="dot"');
    expect(meLink(await (await get("/", cookie)).text())).toContain('class="dot"');
    const me = await (await get("/me", cookie)).text();
    expect(meLink(me)).not.toContain('class="dot"');
    expect(meLink(await (await get("/", cookie)).text())).not.toContain('class="dot"');
    await tick();
    await react(mine);
    expect(meLink(await (await get("/", cookie)).text())).toContain('class="dot"');
  });

  it("ignores the listener's own reactions, hidden ones, and reactions to a hidden letter", async () => {
    const cookie = await signedInSession();
    const id = idOf(cookie);
    const mine = await letterBy(id);
    await react(mine, { listenerId: id });
    await react(mine, { status: "rejected" });
    const hidden = await letterBy(id);
    await env.DB.prepare("UPDATE letters SET status = 'rejected' WHERE id = ?").bind(hidden.id).run();
    await react(hidden);
    expect(meLink(await (await get("/", cookie)).text())).not.toContain('class="dot"');
  });

  it("shows on the settings page too", async () => {
    const cookie = await signedInSession();
    const mine = await letterBy(idOf(cookie));
    await react(mine);
    const html = await (await get("/settings", cookie)).text();
    expect(meLink(html)).toContain('class="dot"');
  });

  it("links a signed-in listener to the settings, after the my page, as a gear named 設定", async () => {
    const html = await (await get("/put", await signedInSession())).text();
    const nav = html.match(/<nav>[\s\S]*?<\/nav>/)?.[0] ?? "";
    // The gear alone keeps the header on one row; the name is for assistive technology and the tooltip.
    expect(nav).toMatch(/<a class="settings-link" href="\/settings" aria-label="設定" title="設定"><span class="gear" aria-hidden="true">⚙\uFE0E<\/span><\/a>/);
    expect(nav.indexOf('href="/settings"')).toBeGreaterThan(nav.indexOf('href="/me"'));
    const here = (await (await get("/settings", await signedInSession())).text()).match(/<nav>[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(here).toMatch(/<a class="settings-link" href="\/settings"[^>]*aria-current="page"/);
    const anon = (await (await get("/put", await newSession())).text()).match(/<nav>[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(anon).not.toContain('href="/settings"');
  });

  it("names the signed-in listener by name alone, the full sentence in its title", async () => {
    const html = await (await get("/put", await signedInSession("Hiro"))).text();
    expect(html).toMatch(/<span class="site-user" title="Hiro としてサインイン中">Hiro<\/span>/);
  });

  it("is never shown to a listener who has not signed in", async () => {
    const cookie = await newSession();
    const mine = await letterBy(idOf(cookie));
    await react(mine);
    const html = await (await get("/", cookie)).text();
    expect(html).not.toContain('class="dot"');
  });
});
