import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/worker/index";
import { createListener, updateListener } from "../../src/worker/db/listeners";
import { t } from "../../src/worker/i18n/t";
import { WindowStore } from "../../src/worker/security/rate-limit";
import { resetDb } from "../helpers/db";
import { newSession } from "./routes/helpers";

const ORIGIN = "http://127.0.0.1:5173";
const e = { ...env, PUBLIC_ORIGIN: ORIGIN, ADMIN_TOKEN: "admin-token-test" };

beforeEach(() => resetDb(env.DB));

const form = (headers: Record<string, string>, path = "/letters") =>
  app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: "itemId=x&body=hello" }, e);

describe("admin", () => {
  it("answers 401 on /admin/found without a token", async () => {
    const res = await app.request("/admin/found", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, e);
    expect(res.status).toBe(401);
  });

  it("is not subject to the origin check (Bearer only)", async () => {
    const res = await app.request("/admin/found", { method: "POST", headers: { origin: "https://evil.example", authorization: "Bearer wrong" } }, e);
    expect(res.status).toBe(401);
  });
});

describe("origin check", () => {
  it("answers 403 for POST /letters from another origin", async () => {
    expect((await form({ origin: "https://evil.example" })).status).toBe(403);
  });

  it("compares the whole origin, not a prefix", async () => {
    expect((await form({ origin: `${ORIGIN}.evil.example` })).status).toBe(403);
    expect((await form({ origin: "null" })).status).toBe(403);
    expect((await form({ origin: "null", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("lets a same-origin form post through when the browser sends Origin: null (strict referrer policy)", async () => {
    expect((await form({ origin: "null", "sec-fetch-site": "same-origin" })).status).not.toBe(403);
  });

  it("lets the same origin through, and a client with neither Origin nor Sec-Fetch-Site", async () => {
    expect((await form({ origin: ORIGIN })).status).not.toBe(403);
    expect((await form({})).status).not.toBe(403);
    expect((await form({ "sec-fetch-site": "same-origin" })).status).not.toBe(403);
    expect((await form({ "sec-fetch-site": "none" })).status).not.toBe(403);
  });

  it("refuses a browser request that sends Sec-Fetch-Site but no Origin from elsewhere", async () => {
    expect((await form({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await form({ "sec-fetch-site": "same-site" })).status).toBe(403);
  });

  it("covers every write route outside /admin and /mcp, and does not mint a listener for a refused one", async () => {
    for (const path of ["/start", "/episodes", "/settings", "/settings/mcp-token", "/takedown"]) {
      const res = await form({ origin: "https://evil.example" }, path);
      expect(res.status, path).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n).toBe(0);
  });

  it("leaves GET alone", async () => {
    expect((await app.request("/healthz", { headers: { origin: "https://evil.example" } }, e)).status).toBe(200);
  });
});

describe("security headers", () => {
  it("sets nosniff on GET /", async () => {
    const res = await app.request("/", {}, e);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("also sets them on static assets", async () => {
    const res = await app.request("/app.css", {}, e);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toContain("text/css");
  });
});

describe("rate limit", () => {
  const post = (ip: string, path = "/letters", extra: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/x-www-form-urlencoded", ...extra }, body: "itemId=x&body=hello" }, e);

  it("answers 429 on the 21st POST /letters from one IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await post("203.0.113.1")).status);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await post("203.0.113.2")).status).not.toBe(429);
  });

  it("shares one IP bucket over letters, start, episodes and the resolvers", async () => {
    for (let i = 0; i < 20; i++) await post("203.0.113.3", ["/letters", "/start", "/episodes"][i % 3]);
    expect((await post("203.0.113.3", "/episodes")).status).toBe(429);
    const resolve = await app.request("/api/resolve?url=x", { headers: { "cf-connecting-ip": "203.0.113.3" } }, e);
    expect(resolve.status).toBe(429);
    const put = await app.request("/put?itemId=x", { headers: { "cf-connecting-ip": "203.0.113.3" } }, e);
    expect(put.status).toBe(429);
  });

  it("limits unknown /mcp tokens by IP (20), and answers 429 in JSON", async () => {
    const hit = () => app.request("/mcp/guess", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.4" } }, e);
    for (let i = 0; i < 20; i++) expect((await hit()).status).toBe(401);
    const res = await hit();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    for (let i = 0; i < 25; i++) expect((await app.request("/healthz", { headers: { "cf-connecting-ip": "203.0.113.4" } }, e)).status).toBe(200);
  });

  it("limits a valid /mcp token by the token (60), not by the shared IP", async () => {
    const a = await createListener(env.DB);
    const b = await createListener(env.DB);
    await updateListener(env.DB, a.id, { mcpToken: "tok-a-valid" });
    await updateListener(env.DB, b.id, { mcpToken: "tok-b-valid" });
    const hit = (token: string) => app.request(`/mcp/${token}`, { method: "POST", headers: { "cf-connecting-ip": "203.0.113.6", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }, e);
    for (let i = 0; i < 60; i++) expect((await hit("tok-a-valid")).status, String(i)).not.toBe(429);
    expect((await hit("tok-a-valid")).status).toBe(429);
    // Another token behind the same IP is unaffected, and so is a guess from that IP.
    expect((await hit("tok-b-valid")).status).not.toBe(429);
    expect((await hit("nope")).status).toBe(401);
  });

  it("answers a form route's 429 with a small HTML page", async () => {
    for (let i = 0; i < 20; i++) await post("203.0.113.7");
    const res = await post("203.0.113.7");
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(t("rate.limited"));
    const next = await app.request("/episodes/x/next", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } }, e);
    expect(next.status).toBe(429);
    expect(await next.json()).toEqual({ error: "rate_limited" });
  });

  it("limits one listener across many IPs", async () => {
    const cookie = await newSession();
    const hit = (ip: string) => app.request("/letters", { method: "POST", headers: { cookie, "cf-connecting-ip": ip, "content-type": "application/x-www-form-urlencoded" }, body: "itemId=x&body=hello" }, e);
    for (let i = 0; i < 20; i++) expect((await hit(`198.51.100.${i + 1}`)).status).not.toBe(429);
    expect((await hit("198.51.100.99")).status).toBe(429);
  });

  it("does not create a listener for a request the IP limit refuses", async () => {
    for (let i = 0; i < 20; i++) await post("203.0.113.5");
    const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n;
    expect((await post("203.0.113.5")).status).toBe(429);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n).toBe(before);
  });
});

describe("WindowStore", () => {
  it("stays under its key cap, dropping the oldest windows when nothing has expired", () => {
    const store = new WindowStore(5);
    for (let i = 0; i < 50; i++) store.increment(`k${i}`);
    expect(store.size).toBe(5);
    expect(store.increment("k49").totalHits).toBe(2);
    expect(store.increment("k0").totalHits).toBe(1);
  });

  it("sweeps expired keys first", () => {
    vi.useFakeTimers();
    try {
      const store = new WindowStore(3);
      store.increment("a");
      store.increment("b");
      vi.advanceTimersByTime(61_000);
      store.increment("c");
      store.increment("d");
      store.increment("e");
      expect(store.size).toBe(3);
      expect(store.increment("c").totalHits).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SESSION_SECRET guard", () => {
  it("answers a plain 500 and logs once when the secret is empty", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { ...e, SESSION_SECRET: "" };
    const first = await app.request("/", {}, bad);
    const second = await app.request("/settings", {}, bad);
    expect(first.status).toBe(500);
    expect(await first.text()).toBe("Server is not configured");
    expect(second.status).toBe(500);
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes("SESSION_SECRET"))).toHaveLength(1);
    // Exempt paths do not need the secret.
    expect((await app.request("/healthz", {}, bad)).status).toBe(200);
    errorSpy.mockRestore();
  });
});

describe("session exemptions", () => {
  it("do not create listener rows for static assets and /api", async () => {
    for (const path of ["/app.css", "/icon.svg", "/manifest.webmanifest", "/bed.mp3", "/healthz", "/api/search"]) {
      const res = await SELF.fetch(`http://example.com${path}`);
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n).toBe(0);
  });
});
