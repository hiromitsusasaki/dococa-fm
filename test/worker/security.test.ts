import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/worker/index";
import { t } from "../../src/worker/i18n/t";
import { isSessionExempt } from "../../src/worker/auth/session";
import { isFramedPath } from "../../src/worker/routes/letter-page";
import { WindowStore, isRateLimited } from "../../src/worker/security/rate-limit";
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

  it("covers every write route outside /admin, and does not mint a listener for a refused one", async () => {
    for (const path of ["/start", "/episodes", "/settings", "/takedown", "/listens"]) {
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

  it("shares one IP bucket over letters, start, episodes and the resolver", async () => {
    for (let i = 0; i < 20; i++) await post("203.0.113.3", ["/letters", "/start", "/episodes"][i % 3]);
    expect((await post("203.0.113.3", "/episodes")).status).toBe(429);
    const put = await app.request("/put?itemId=x", { headers: { "cf-connecting-ip": "203.0.113.3" } }, e);
    expect(put.status).toBe(429);
  });

  it("counts POST /settings in the IP bucket, since it writes", async () => {
    for (let i = 0; i < 20; i++) await post("203.0.113.9", "/settings");
    expect((await post("203.0.113.9", "/settings")).status).toBe(429);
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

describe("body limits", () => {
  const big = (bytes: number) => `body=${"a".repeat(bytes)}`;

  it("answers 413 for a public POST over 64 KB before reading it, without minting a listener", async () => {
    const res = await app.request("/letters", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: big(70 * 1024) }, e);
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("Payload too large");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n).toBe(0);
  });

  it("counts a streamed body without Content-Length too", async () => {
    const chunk = new TextEncoder().encode("a".repeat(16 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await app.request("/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: stream, duplex: "half" } as RequestInit, e);
    expect(res.status).toBe(413);
  });

  it("lets a small public POST and a 70 KB admin batch through to their routes, and stops admin at 1 MB", async () => {
    expect((await app.request("/letters", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: big(1024) }, e)).status).not.toBe(413);
    const admin = (bytes: number) =>
      app.request("/admin/found", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify({ pad: "a".repeat(bytes) }) }, e);
    expect((await admin(70 * 1024)).status).toBe(401);
    expect((await admin(1100 * 1024)).status).toBe(413);
  });
});

describe("PUBLIC_ORIGIN guard", () => {
  it("answers a plain 500 everywhere but /healthz and logs once when the origin is empty", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { ...e, PUBLIC_ORIGIN: "" };
    for (const [path, init] of [["/", {}], ["/settings", {}], ["/letters", { method: "POST" }], ["/admin/items", { method: "POST" }]] as const) {
      const res = await app.request(path, init, bad);
      expect(res.status, path).toBe(500);
      expect(await res.text()).toBe("Server is not configured");
    }
    expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes("PUBLIC_ORIGIN"))).toHaveLength(1);
    expect((await app.request("/healthz", {}, bad)).status).toBe(200);
    // Refused before the session middleware: no listener row was minted.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n).toBe(0);
    errorSpy.mockRestore();
  });
});

describe("canonical host", () => {
  const prod = { ...e, PUBLIC_ORIGIN: "https://dococafm.app" };
  const OLD = "dococa-fm.promitsu.workers.dev";

  it("redirects a GET on another host to PUBLIC_ORIGIN, keeping path and query, without a cookie", async () => {
    const res = await app.request("/items/abc?x=1", { headers: { host: OLD } }, prod);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://dococafm.app/items/abc?x=1");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not redirect the canonical host", async () => {
    expect((await app.request("/items/abc?x=1", { headers: { host: "dococafm.app" } }, prod)).status).not.toBe(301);
  });

  it("keeps /healthz up on any host", async () => {
    expect((await app.request("/healthz", { headers: { host: OLD } }, prod)).status).toBe(200);
  });

  it("refuses a write on another host", async () => {
    const res = await app.request("/letters", { method: "POST", headers: { host: OLD, "content-type": "application/x-www-form-urlencoded" }, body: "itemId=x&body=hello" }, prod);
    expect(res.status).toBe(403);
  });

  it("treats localhost as another host for a 127.0.0.1 dev origin", async () => {
    expect((await app.request("/", { headers: { host: "127.0.0.1:5173" } }, e)).status).not.toBe(301);
    const res = await app.request("/settings?a=b", { headers: { host: "localhost:5173" } }, e);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:5173/settings?a=b");
  });
});

describe("session exemptions", () => {
  it("do not create listener rows for static assets", async () => {
    const shared = "/letters/00000000-0000-4000-8000-000000000000";
    for (const path of ["/app.css", "/icon.svg", "/manifest.webmanifest", "/bed-3.mp3", "/healthz", `${shared}/player`, `${shared}/lines.json`, `${shared}/audio/3`]) {
      const res = await SELF.fetch(`http://example.com${path}`);
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n).toBe(0);
  });
});

describe("the shared letter's routes", () => {
  it("exempt the player, the lines and the clips from the session, and keep it on the page", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const path of [`/letters/${id}/player`, `/letters/${id}/lines.json`, `/letters/${id}/audio/0`]) expect(isSessionExempt(path), path).toBe(true);
    for (const path of [`/letters/${id}`, `/letters/${id}/reactions`, `/letters/${id}/player/x`]) expect(isSessionExempt(path), path).toBe(false);
  });

  it("are all GET, and none of them counts in the shared buckets", () => {
    const shared = app.routes.filter((r) => r.path.startsWith("/letters/:id") && r.path !== "/letters/:id/reactions" && r.path !== "/letters/:id/report");
    expect(shared.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["GET /letters/:id", "GET /letters/:id/audio/:n", "GET /letters/:id/audio/:n", "GET /letters/:id/lines.json", "GET /letters/:id/player"]);
    for (const r of shared) expect(isRateLimited("GET", r.path.replace(/:[A-Za-z]+/g, "x"), new URLSearchParams())).toBe(false);
  });
});

describe("the temporary /api routes", () => {
  it("are gone, and nothing limits or exempts /api any more", async () => {
    expect(app.routes.some((r) => r.path.startsWith("/api"))).toBe(false);
    for (const path of ["/api/search?q=x", "/api/resolve?url=https%3A%2F%2Fexample.com%2F"]) expect((await app.request(path, {}, e)).status, path).toBe(404);
    expect(isRateLimited("GET", "/api/search", new URLSearchParams())).toBe(false);
  });
});

describe("isRateLimited for /put/register", () => {
  it("limits the register post and not a get", () => {
    expect(isRateLimited("POST", "/put/register", new URLSearchParams())).toBe(true);
    expect(isRateLimited("GET", "/put/register", new URLSearchParams())).toBe(false);
  });
});

/** POST routes outside the shared buckets, and why. Each must be limited some other way (tested below). */
const OWN_LIMITER: Record<string, string> = { "/listens": "own limiter" };

describe("rate-limit allowlist covers every write route", () => {
  it("counts every registered POST route outside /admin, except the ones with their own limiter", () => {
    const posts = [...new Set(app.routes.filter((r) => r.method === "POST" || r.method === "ALL").map((r) => r.path))]
      .filter((p) => !p.startsWith("/admin") && p !== "*" && !p.includes("*"))
      .map((p) => p.replace(/:[A-Za-z]+/g, "x"));
    expect(posts).not.toContain("/settings/dial");
    expect(posts).toContain("/listens");
    expect(posts.length).toBeGreaterThan(8);
    for (const path of posts) expect(isRateLimited("POST", path, new URLSearchParams()), path).toBe(!(path in OWN_LIMITER));
  });

  it("gives /listens its own buckets: the shared ones do not count it, and its own answers 429 in JSON after its window", async () => {
    // RATE_LIMIT_PER_MINUTE=1 scales the buckets down: 6 a minute per listener, 12 per IP.
    const slow = { ...e, RATE_LIMIT_PER_MINUTE: "1" };
    const listen = (cookie: string, ip: string) =>
      app.request("/listens", { method: "POST", headers: { cookie, "cf-connecting-ip": ip, "content-type": "application/json" }, body: JSON.stringify({ episodeId: "x", letterId: "y", segmentIndex: 0 }) }, slow);
    const cookie = await newSession();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await listen(cookie, "203.0.113.70")).status);
    expect(statuses.slice(0, 6).every((s) => s === 404)).toBe(true);
    expect(statuses[6]).toBe(429);
    expect(await (await listen(cookie, "203.0.113.70")).json()).toEqual({ error: "rate_limited" });
    // The shared bucket of that IP was not touched: a POST /letters from it still gets through the limiter.
    const letters = await app.request("/letters", { method: "POST", headers: { cookie, "cf-connecting-ip": "203.0.113.70", "content-type": "application/x-www-form-urlencoded" }, body: "itemId=x&body=hello" }, slow);
    expect(letters.status).not.toBe(429);

    const byIp: number[] = [];
    for (let i = 0; i < 13; i++) byIp.push((await listen(await newSession(), "203.0.113.71")).status);
    expect(byIp.slice(0, 12).every((s) => s === 404)).toBe(true);
    expect(byIp[12]).toBe(429);
  });

  it("refuses a cookie-less /listens flood by IP before the session, minting no listener row", async () => {
    const slow = { ...e, RATE_LIMIT_PER_MINUTE: "1" };
    const bare = () =>
      app.request("/listens", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.72", "content-type": "application/json" }, body: JSON.stringify({ episodeId: "x", letterId: "y" }) }, slow);
    for (let i = 0; i < 12; i++) await bare();
    const rows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n;
    const before = await rows();
    const refused = await bare();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await rows()).toBe(before);
  });
});

describe("isFramedPath", () => {
  it("frames only the exact /letters/<id>/player", () => {
    const id = "6b1c2f0e-1111-4aaa-8bbb-0c0ffee00011";
    expect(isFramedPath(`/letters/${id}/player`)).toBe(true);
    for (const path of [
      `/letters/${id}/player/`,
      `/letters/${id}/player/..`,
      `/letters/${id}/player/x`,
      `/Letters/${id}/player`,
      `/letters/${id}/PLAYER`,
      `/letters/${id}`,
      `/letters/${id}/lines.json`,
      `/x/letters/${id}/player`,
      `/letter/${id}/player`,
      "/letters//player",
    ]) expect(isFramedPath(path), path).toBe(false);
  });

  it("frames an encoded slash or an uppercase id only as a path the route answers with a bare 404", async () => {
    for (const id of ["a%2Fb", "6B1C2F0E-1111-4AAA-8BBB-0C0FFEE00011"]) {
      const res = await app.request(`/letters/${id}/player`, {}, e);
      expect(res.status, id).toBe(404);
      expect(await res.text(), id).not.toContain("<form");
    }
  });
});
