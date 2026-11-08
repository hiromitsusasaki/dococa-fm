import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "../db/helpers";
import { BASE, get, newSession, signedInSession } from "./helpers";

beforeEach(() => resetDb(env.DB));

const SENT = 'window.parent.postMessage({type:"dfm:sent"},location.origin)';

describe("GET /put?embed=1 (the home's send modal)", () => {
  it("is the same page without the header, and keeps its forms and links in the frame", async () => {
    const cookie = await signedInSession();
    const html = await (await get("/put?embed=1", cookie)).text();
    expect(html).not.toContain('class="site-header"');
    expect(html).toContain('<body class="embed">');
    expect(html).toContain('class="put"');
    expect(html).not.toContain("<base");
    // The url form and the search form answer inside the frame.
    expect((html.match(/<input type="hidden" name="embed" value="1"\/>/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(SENT);
    // Escape inside the frame asks the home to close the modal.
    expect(html).toContain('parent.postMessage({type:"dfm:close"},location.origin)');
    // The bookmarklet stays on /put itself, not in the modal.
    expect(html).not.toContain("put-bookmarklet");
    expect(await (await get("/put", cookie)).text()).toContain("put-bookmarklet");
  });

  it("a chosen work's letter form and its settings link: the form stays, the settings page opens over the home", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    const html = await (await get(`/put?embed=1&itemId=${item.id}`, cookie)).text();
    expect(html).toMatch(/<form method="post" action="\/letters" class="put-form"><input type="hidden" name="embed" value="1"\/>/);
    expect(html).toContain('<a href="/settings" target="_top">');
  });

  it("an anonymous listener's sign-in leaves the frame (Google cannot be framed) and comes back home", async () => {
    const html = await (await get("/put?embed=1", await newSession())).text();
    expect(html).toContain(`<a href="/auth/google?next=${encodeURIComponent("/")}" target="_top">`);
  });

  it("the sent state says so, links to the work over the home, and tells the home to close", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    const html = await (await get(`/put?embed=1&sent=${item.id}`, cookie)).text();
    expect(html).toContain("届きました");
    expect(html).toContain(`<a href="/items/${item.id}" target="_top">`);
    expect(html).toContain('href="/put?embed=1"');
    expect(html).toContain(SENT);
    expect(html).not.toContain('class="site-header"');
    // An unknown work: still sent, without the link.
    const unknown = await (await get("/put?embed=1&sent=nope", cookie)).text();
    expect(unknown).toContain(SENT);
    expect(unknown).not.toContain('href="/items/');
  });

  it("GET /put is unchanged: the header, no embed fields, and no message even with sent=", async () => {
    const cookie = await signedInSession();
    for (const path of ["/put", "/put?sent=x"]) {
      const html = await (await get(path, cookie)).text();
      expect(html).toContain('class="site-header"');
      expect(html).not.toContain('name="embed"');
      expect(html).not.toContain(SENT);
      expect(html).not.toContain("dfm:close");
      expect(html).not.toContain('target="_top"');
    }
  });
});

describe("the ask-back on the send page", () => {
  let create: ReturnType<typeof stubAnthropic>;
  beforeEach(() => {
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "sk-test";
    create = stubAnthropic();
    create.mockResolvedValue(toolUse("ask", { questions: [] }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const ask = (cookie: string, body: unknown) =>
    SELF.fetch(`${BASE}/put/ask`, { method: "POST", headers: { cookie, "content-type": "application/json", accept: "application/json", "sec-fetch-mode": "same-origin" }, body: JSON.stringify(body) });
  const said = (question: string) => create.mockImplementation((req) => (req.tools[0].name === "ask_back" ? toolUse("ask_back", { question }) : toolUse("ask", { questions: [] })));

  it("shows the button, its note and the reply slot for a stored work, also in the frame; not without a stored work", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    for (const path of [`/put?itemId=${item.id}`, `/put?embed=1&itemId=${item.id}`]) {
      const html = await (await get(path, cookie)).text();
      expect(html).toContain('class="put-ask"');
      expect(html).toContain("DJ に問い返してもらう");
      expect(html).toContain("書きかけは保存しません");
      expect(html).toContain('class="put-askback"');
      expect(html).toContain("いまは問いを思いつきませんでした");
      expect(html).toMatch(/assets\/put-page\.js|\/src\/client\/put-page\.tsx/);
    }
    expect(await (await get("/put", cookie)).text()).not.toContain('class="put-ask"');
  });

  it("answers 401 in JSON without a sign-in", async () => {
    const res = await ask(await newSession(), { itemId: "x", draft: "あ" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signin" });
  });

  it("answers 422 for an empty draft and 404 for an unknown work", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    expect((await ask(cookie, { itemId: item.id, draft: "  " })).status).toBe(422);
    expect((await ask(cookie, { itemId: item.id })).status).toBe(422);
    expect((await ask(cookie, { itemId: "nope", draft: "あ" })).status).toBe(404);
  });

  it("returns the one question and sends the draft to Claude only", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    said("その頃、いちばんよく聴いていた場所はどこでしたか？");
    const res = await ask(cookie, { itemId: item.id, draft: "雨の日に聴くと落ち着きます" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ question: "その頃、いちばんよく聴いていた場所はどこでしたか？" });
    const sent = JSON.stringify(create.mock.calls[0]![0]);
    expect(sent).toContain("雨の日に聴くと落ち着きます");
    expect(sent).toContain("Blue in Green");
    // Nothing of the draft is kept: not in any table, not in a log.
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    for (const { name } of results) {
      if (name.startsWith("sqlite_") || name.startsWith("_cf_") || name.startsWith("d1_")) continue;
      expect(JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results)).not.toContain("雨の日に聴くと");
    }
  });

  it("returns no question for a reply with a topical word, one that quotes the draft, or a failed call", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    said("今日のニュースを聞きましたか？");
    expect(await (await ask(cookie, { itemId: item.id, draft: "雨の日に聴くと落ち着きます" })).json()).toEqual({ question: null });
    said("雨の日に聴くと落ち着きます、とは？");
    expect(await (await ask(cookie, { itemId: item.id, draft: "雨の日に聴くと落ち着きます" })).json()).toEqual({ question: null });
    create.mockRejectedValue(new Error("boom"));
    expect(await (await ask(cookie, { itemId: item.id, draft: "雨の日に聴くと落ち着きます" })).json()).toEqual({ question: null });
  });

  it("is rate limited at 6 a minute per listener", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    said("どんな場面でしたか？");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await ask(cookie, { itemId: item.id, draft: "あいう" })).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});
