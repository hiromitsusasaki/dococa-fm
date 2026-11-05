import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "../../../src/worker/auth/crypto";
import * as listeners from "../../../src/worker/db/listeners";
import { createListener, getListener, updateListener } from "../../../src/worker/db/listeners";
import { t } from "../../../src/worker/i18n/t";
import { json, stubFetch } from "../../helpers/fetch";
import { resetDb } from "../../helpers/db";
import { BASE, newSession } from "./helpers";

const mutable = env as { GOOGLE_OAUTH_CLIENT_ID: string; GOOGLE_OAUTH_CLIENT_SECRET: string };
const enc = new TextEncoder();
const idToken = (payload: Record<string, unknown>) => {
  const part = (o: unknown) => toBase64Url(enc.encode(JSON.stringify(o)));
  return `${part({ alg: "RS256" })}.${part(payload)}.sig`;
};
const sidOf = (res: Response) => (res.headers.get("set-cookie") ?? "").match(/dfm_sid=([^;.]+)/)?.[1];
const manual = (path: string, cookie: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, { redirect: "manual", ...init, headers: { cookie, ...(init.headers ?? {}) } });

/** Starts the flow and returns what the callback needs: the cookie header and the state/nonce inside it. */
async function start(sid: string, next?: string) {
  const res = await manual(`/auth/google${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`, sid);
  const raw = (res.headers.get("set-cookie") ?? "").match(/dfm_oauth=([^;]+)/)?.[1] ?? "";
  const [state, nonce, ...rest] = decodeURIComponent(raw).split(".");
  const enc_next = rest.join(".");
  return { res, cookie: `${sid}; dfm_oauth=${raw}`, state: state!, nonce: nonce!, next: enc_next ? decodeURIComponent(enc_next) : undefined };
}

function stubGoogle(claims: Record<string, unknown> | ((nonce: string) => Record<string, unknown>), nonce: string, status = 200) {
  const c = typeof claims === "function" ? claims(nonce) : claims;
  return stubFetch([
    ["https://oauth2.googleapis.com/token", () => json({ id_token: idToken({ iss: "https://accounts.google.com", aud: "cid", exp: Math.floor(Date.now() / 1000) + 600, nonce, sub: "g-1", name: "Aiko", email: "aiko@example.com", ...c }) }, status)],
  ]);
}

beforeEach(async () => {
  await resetDb(env.DB);
  mutable.GOOGLE_OAUTH_CLIENT_ID = "cid";
  mutable.GOOGLE_OAUTH_CLIENT_SECRET = "sec";
});
afterEach(() => {
  mutable.GOOGLE_OAUTH_CLIENT_ID = "";
  mutable.GOOGLE_OAUTH_CLIENT_SECRET = "";
  vi.unstubAllGlobals();
});

describe("GET /auth/google", () => {
  it("redirects to Google and sets the oauth cookie", async () => {
    const sid = await newSession();
    const { res, state, nonce } = await start(sid, "/me");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("accounts.google.com");
    expect(loc).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A5173%2Fauth%2Fgoogle%2Fcallback");
    expect(loc).toContain(`state=${state}`);
    expect(loc).toContain(`nonce=${nonce}`);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/auth\/google/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });

  it("answers 503 when the client id is empty", async () => {
    mutable.GOOGLE_OAUTH_CLIENT_ID = "";
    const sid = await newSession();
    const res = await manual("/auth/google", sid);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t("signin.unavailable", undefined, "ja"));
  });

  it.each([["//evil.example"], ["/%09/evil.com"], ["/\t/evil.com"], ["/\n/evil.com"], ["/%0a/evil.com"], ["/\\evil.com"], ["https://evil.example"], ["me"], ["/" + "a".repeat(250)]])("falls back to /me for next=%s", async (bad) => {
    const sid = await newSession();
    expect((await start(sid, bad)).next).toBe("/me");
  });

  it("keeps a next path that contains a dot through the callback", async () => {
    const sid = await newSession();
    const s = await start(sid, "/stations/a.b?x=1");
    expect(s.next).toBe("/stations/a.b?x=1");
    stubGoogle({}, s.nonce);
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    expect(res.headers.get("location")).toBe("/stations/a.b?x=1");
  });

  it("keeps a safe next path", async () => {
    const sid = await newSession();
    expect((await start(sid, "/settings?x=1")).next).toBe("/settings?x=1");
  });
});

describe("GET /auth/google/callback", () => {
  it("sends a mismatched state to /settings?signin=failed", async () => {
    const sid = await newSession();
    const s = await start(sid);
    const res = await manual("/auth/google/callback?code=c&state=wrong", s.cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings?signin=failed");
  });

  it("sends a request without the oauth cookie to /settings?signin=failed", async () => {
    const sid = await newSession();
    const res = await manual("/auth/google/callback?code=c&state=x", sid);
    expect(res.headers.get("location")).toBe("/settings?signin=failed");
  });

  it("fails when the token exchange fails", async () => {
    const sid = await newSession();
    const s = await start(sid);
    stubGoogle({}, s.nonce, 500);
    const res = await manual(`/auth/google/callback?code=c&state=${s.state}`, s.cookie);
    expect(res.headers.get("location")).toBe("/settings?signin=failed");
  });

  it("fails when the id token has the wrong nonce", async () => {
    const sid = await newSession();
    const s = await start(sid);
    stubGoogle({ nonce: "other" }, s.nonce);
    const res = await manual(`/auth/google/callback?code=c&state=${s.state}`, s.cookie);
    expect(res.headers.get("location")).toBe("/settings?signin=failed");
  });

  it("binds a new sub to the current listener and keeps the google name private", async () => {
    const sid = await newSession();
    const id = sid.split("=")[1]!.split(".")[0]!;
    const s = await start(sid, "/settings");
    const stub = stubGoogle({}, s.nonce);
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    expect(res.headers.get("set-cookie")).toMatch(/dfm_oauth=;.*Max-Age=0/);
    expect(sidOf(res)).toBeUndefined();
    expect(stub.calls()).toEqual(["https://oauth2.googleapis.com/token"]);
    const listener = await getListener(env.DB, id);
    expect(listener?.googleSub).toBe("g-1");
    expect(listener?.displayName).toBe("Aiko");
    expect(listener?.radioName).toBe("");
  });

  it("uses the email local part as the private display name when there is no name, and keeps an existing radio name", async () => {
    const sid = await newSession();
    const id = sid.split("=")[1]!.split(".")[0]!;
    await updateListener(env.DB, id, { radioName: "My Radio" });
    const s = await start(sid);
    stubGoogle({ name: "" }, s.nonce);
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    expect(res.headers.get("location")).toBe("/me");
    const listener = await getListener(env.DB, id);
    expect(listener?.displayName).toBe("aiko");
    expect(listener?.radioName).toBe("My Radio");
  });

  it("never overwrites a listener already bound to another Google account", async () => {
    const sid = await newSession();
    const id = sid.split("=")[1]!.split(".")[0]!;
    await updateListener(env.DB, id, { googleSub: "g-other", displayName: "Other" });
    const s = await start(sid);
    stubGoogle({}, s.nonce);
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    expect(res.headers.get("location")).toBe("/settings?signin=failed");
    expect((await getListener(env.DB, id))?.googleSub).toBe("g-other");
  });

  it("switches to the winner when the sub gets bound between lookup and write", async () => {
    const owner = await createListener(env.DB, { lang: "ja" });
    const sid = await newSession();
    const s = await start(sid);
    stubGoogle({}, s.nonce);
    const real = listeners.getListenerByGoogleSub;
    let calls = 0;
    const spy = vi.spyOn(listeners, "getListenerByGoogleSub").mockImplementation(async (db, sub) => {
      if (calls++ === 0) {
        await updateListener(db, owner.id, { googleSub: sub });
        return null;
      }
      return real(db, sub);
    });
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    spy.mockRestore();
    expect(res.headers.get("location")).toBe("/me");
    expect(sidOf(res)).toBe(owner.id);
  });

  it("fails, and keeps the first account, when the listener is bound to another account between lookup and write", async () => {
    const sid = await newSession();
    const id = sid.split("=")[1]!.split(".")[0]!;
    const s = await start(sid);
    stubGoogle({ sub: "g-second" }, s.nonce);
    const real = listeners.getListenerByGoogleSub;
    let calls = 0;
    const spy = vi.spyOn(listeners, "getListenerByGoogleSub").mockImplementation(async (db, sub) => {
      if (calls++ === 0) {
        await updateListener(db, id, { googleSub: "g-first", displayName: "First" });
        return null;
      }
      return real(db, sub);
    });
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    spy.mockRestore();
    expect(res.headers.get("location")).toBe("/settings?signin=failed");
    const after = await getListener(env.DB, id);
    expect(after?.googleSub).toBe("g-first");
    expect(after?.displayName).toBe("First");
  });

  it("carries on when the same account got bound to this listener between lookup and write", async () => {
    const sid = await newSession();
    const id = sid.split("=")[1]!.split(".")[0]!;
    const s = await start(sid);
    stubGoogle({}, s.nonce);
    const real = listeners.getListenerByGoogleSub;
    let calls = 0;
    const spy = vi.spyOn(listeners, "getListenerByGoogleSub").mockImplementation(async (db, sub) => {
      if (calls++ === 0) {
        await updateListener(db, id, { googleSub: sub, displayName: "Aiko" });
        return null;
      }
      return real(db, sub);
    });
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    spy.mockRestore();
    expect(res.headers.get("location")).toBe("/me");
    expect(sidOf(res)).toBeUndefined();
  });

  it("binds with a write that only succeeds while google_sub is empty", async () => {
    const a = await createListener(env.DB, { lang: "ja" });
    expect(await listeners.bindGoogleSub(env.DB, a.id, "g-a", "A")).toBe(true);
    expect(await listeners.bindGoogleSub(env.DB, a.id, "g-b", "B")).toBe(false);
    expect((await getListener(env.DB, a.id))?.googleSub).toBe("g-a");
    const b = await createListener(env.DB, { lang: "ja" });
    await expect(listeners.bindGoogleSub(env.DB, b.id, "g-a", "B")).rejects.toThrow();
  });

  it("switches the session to the listener that already owns the sub", async () => {
    const owner = await createListener(env.DB, { lang: "ja" });
    await updateListener(env.DB, owner.id, { googleSub: "g-1", displayName: "Aiko" });
    const sid = await newSession();
    const currentId = sid.split("=")[1]!.split(".")[0]!;
    const s = await start(sid);
    stubGoogle({}, s.nonce);
    const res = await manual(`/auth/google/callback?code=abc&state=${s.state}`, s.cookie);
    expect(res.status).toBe(303);
    expect(sidOf(res)).toBe(owner.id);
    expect((await getListener(env.DB, currentId))?.googleSub).toBeNull();
  });
});

describe("POST /auth/signout", () => {
  it("clears the session cookie and goes home", async () => {
    const sid = await newSession();
    const res = await manual("/auth/signout", sid, { method: "POST", headers: { origin: env.PUBLIC_ORIGIN } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toMatch(/dfm_sid=;.*Max-Age=0/);
  });

  it("refuses a cross-site post", async () => {
    const sid = await newSession();
    const res = await manual("/auth/signout", sid, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("/settings?signin=failed", () => {
  it("shows the failure message", async () => {
    const sid = await newSession();
    const res = await SELF.fetch(`${BASE}/settings?signin=failed`, { headers: { cookie: sid } });
    expect(await res.text()).toContain(t("signin.failed", undefined, "ja"));
  });
});
