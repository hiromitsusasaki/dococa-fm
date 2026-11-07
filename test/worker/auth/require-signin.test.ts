import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { t } from "../../../src/worker/i18n/t";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "../db/helpers";
import { BASE, get, newSession, postForm, signedInSession } from "../routes/helpers";

beforeEach(() => resetDb(env.DB));

const manual = (path: string, cookie: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie, ...headers } });

describe("requireSignin", () => {
  it("sends an anonymous page request to sign-in and back", async () => {
    const res = await manual("/start", await newSession(), { accept: "text/html" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/google?next=%2Fstart");
  });

  it("keeps the query of the page it came from", async () => {
    const res = await manual("/me?x=1", await newSession());
    expect(res.headers.get("location")).toBe(`/auth/google?next=${encodeURIComponent("/me?x=1")}`);
  });

  it("answers a script with 401 and a reason", async () => {
    const res = await manual("/start", await newSession(), { accept: "application/json" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signin" });
    const fetched = await manual("/me", await newSession(), { "sec-fetch-mode": "same-origin" });
    expect(fetched.status).toBe(401);
  });

  it("gates POST /start and Spotify, and lets a signed-in listener through", async () => {
    const anon = await newSession();
    expect((await postForm("/start", anon, { fav1: "x" })).headers.get("location")).toBe("/auth/google?next=%2Fstart");
    expect((await manual("/auth/spotify", anon)).headers.get("location")).toBe("/auth/google?next=%2Fauth%2Fspotify");
    expect((await get("/start", await signedInSession())).status).toBe(200);
  });
});

describe("POST /letters", () => {
  it("needs sign-in for a letter, with the put page as the way back", async () => {
    const res = await postForm("/letters", await newSession(), { kind: "letter", body: "hi", url: "https://example.com" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/auth/google?next=%2Fput");
    const json = await SELF.fetch(`${BASE}/letters`, { method: "POST", headers: { cookie: await newSession(), accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: "kind=letter&body=hi" });
    expect(json.status).toBe(401);
  });

  it("leaves 私も and a reply to anonymous listeners (they fail later on the missing parent, not on sign-in)", async () => {
    for (const kind of ["watashimo", "reply"]) {
      const res = await postForm("/letters", await newSession(), { kind, body: "x", parentLetterId: "nope" });
      expect(res.headers.get("location") ?? "").not.toContain("/auth/google");
    }
  });
});

describe("site header", () => {
  it("offers sign-in to an anonymous listener and the my page to a signed-in one", async () => {
    const anon = await (await get("/settings", await newSession())).text();
    expect(anon).toContain('class="site-header"');
    expect(anon).toContain(t("signin.google"));
    expect(anon).not.toContain('href="/me"');
    const signed = await (await get("/settings", await signedInSession("Hiro"))).text();
    expect(signed).toContain('href="/me"');
    expect(signed).toContain(t("signin.as", { name: "Hiro" }));
    expect(signed).toContain(t("signin.out"));
  });
});

describe("sign-in link", () => {
  it("returns to the page it is shown on", async () => {
    const next = async (path: string) => (await (await get(path, await newSession())).text()).match(/href="\/auth\/google\?next=([^"]*)"/)?.[1];
    expect(await next("/")).toBe("%2F");
    expect(await next("/stations/world")).toBe("%2Fstations%2Fworld");
    expect(await next("/settings")).toBe("%2Fsettings");
  });
});

describe("GET /put", () => {
  it("shows an anonymous listener the sign-in notice instead of the form", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const anon = await (await get(`/put?itemId=${item.id}`, await newSession())).text();
    expect(anon).not.toContain('action="/letters"');
    expect(anon).toContain(t("signin.needed"));
    // It names what needs the sign-in: a letter, not "favourites".
    expect(t("signin.needed")).toMatch(/^お便りを送るには、サインインが要ります。/);
    expect(t("signin.needed", undefined, "en")).toMatch(/^Sign in to send a letter\./);
    expect(anon).toContain("/auth/google?next=");
    expect(await (await get(`/put?itemId=${item.id}`, await signedInSession())).text()).toContain('action="/letters"');
  });
});
