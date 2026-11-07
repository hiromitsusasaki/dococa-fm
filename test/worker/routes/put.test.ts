import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "../db/helpers";
import { get, newSession, signedInSession } from "./helpers";

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
      expect(html).not.toContain('target="_top"');
    }
  });
});
