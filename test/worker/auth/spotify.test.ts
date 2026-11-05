import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../../../src/worker/auth/crypto";
import { authorizeUrl, importSpotifyHistory } from "../../../src/worker/auth/spotify";
import { listHistory } from "../../../src/worker/db/history";
import { createListener, getListener, updateListener } from "../../../src/worker/db/listeners";
import { t } from "../../../src/worker/i18n/t";
import { json, stubFetch } from "../../helpers/fetch";
import { resetDb } from "../../helpers/db";
import { BASE, newSession, signedInSession } from "../routes/helpers";

let warn: ReturnType<typeof vi.spyOn>;
const mutable = env as { SPOTIFY_CLIENT_ID: string };
const SECRET = env.SESSION_SECRET;

type Fake = { id: string; name: string; artist: string; itunes?: string };
const track = (f: Fake) => ({
  id: f.id,
  name: f.name,
  artists: [{ name: f.artist }],
  album: { release_date: "2019-05-03", images: [{ url: `https://img/${f.id}-s.jpg`, width: 64 }, { url: `https://img/${f.id}-l.jpg`, width: 640 }] },
  external_urls: { spotify: `https://open.spotify.com/track/${f.id}` },
});

const T1: Fake = { id: "s1", name: "Song One", artist: "Artist A", itunes: "101" };
const T2: Fake = { id: "s2", name: "Song Two", artist: "Artist B", itunes: "102" };
const T3: Fake = { id: "s3", name: "Song Three", artist: "Artist C", itunes: "103" };
const T4: Fake = { id: "s4", name: "Lost Song", artist: "Artist D" };

type Opts = { topStatus?: number; top?: Fake[]; recent?: Fake[]; saved?: Fake[]; tokenStatus?: number; recentStatus?: number; newRefresh?: string; itunes?: Fake[] };

function stubWorld(o: Opts = {}) {
  const known = o.itunes ?? [T1, T2, T3];
  const tokenBodies: URLSearchParams[] = [];
  const stub = stubFetch([
    [
      "https://accounts.spotify.com/api/token",
      async (_u, init) => {
        tokenBodies.push(new URLSearchParams(String(init?.body)));
        if (o.tokenStatus && o.tokenStatus !== 200) return json({ error: o.tokenStatus === 400 ? "invalid_grant" : "server_error" }, o.tokenStatus);
        return json({ access_token: "at-1", refresh_token: o.newRefresh ?? "rt-from-spotify" });
      },
    ],
    ["https://api.spotify.com/v1/me/top/tracks", () => (o.topStatus && o.topStatus !== 200 ? json({}, o.topStatus) : json({ items: (o.top ?? [T1, T2]).map(track) }))],
    [
      "https://api.spotify.com/v1/me/player/recently-played",
      () =>
        o.recentStatus && o.recentStatus !== 200
          ? json({}, o.recentStatus)
          : json({ items: (o.recent ?? [T3, T2]).map((f) => ({ track: track(f), played_at: "2026-10-30T10:00:00Z" })) }),
    ],
    ["https://api.spotify.com/v1/me/tracks", () => json({ items: (o.saved ?? [T4]).map((f) => ({ track: track(f), added_at: "2026-09-01T00:00:00Z" })) })],
    [
      "https://itunes.apple.com/search",
      (url) => {
        const term = new URL(url).searchParams.get("term") ?? "";
        const hit = known.find((f) => term === `${f.name} ${f.artist}`);
        return json({
          results: hit
            ? [
                { trackId: 999, trackName: "Wrong Artist Cover", artistName: "Somebody Else", previewUrl: "https://p/x.m4a" },
                { trackId: Number(hit.itunes), trackName: hit.name, artistName: hit.artist, previewUrl: `https://p/${hit.itunes}.m4a`, artworkUrl100: "https://a/100x100.jpg", releaseDate: "2019-01-01T00:00:00Z" },
              ]
            : [],
        });
      },
    ],
  ]);
  return { ...stub, tokenBodies };
}

async function connectedListener(refresh = "rt-original") {
  const l = await createListener(env.DB);
  return (await updateListener(env.DB, l.id, { spotifyRefreshToken: await encryptSecret(refresh, SECRET) }))!;
}

beforeEach(async () => {
  await resetDb(env.DB);
  mutable.SPOTIFY_CLIENT_ID = "cid-test";
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  mutable.SPOTIFY_CLIENT_ID = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authorizeUrl", () => {
  it("carries PKCE S256, the three scopes and the callback", () => {
    const url = new URL(authorizeUrl(env, "chal", "st"));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid-test");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("scope")).toBe("user-top-read user-read-recently-played user-library-read");
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.PUBLIC_ORIGIN}/auth/spotify/callback`);
  });
});

describe("importSpotifyHistory", () => {
  it("imports every unique track, keeping Spotify tracks iTunes cannot match", async () => {
    const world = stubWorld();
    const listener = await connectedListener();
    const n = await importSpotifyHistory(env, env.DB, listener);
    expect(n).toBe(4);
    const rows = await listHistory(env.DB, listener.id, 50);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.source === "spotify")).toBe(true);

    const by = (id: string) => rows.find((r) => r.item.externalIds.spotify === id)!;
    const matched = by("s1").item;
    expect(Object.keys(matched.externalIds)).toEqual(["spotify", "itunes"]);
    expect(matched).toMatchObject({ title: "Song One", creator: "Artist A", previewUrl: "https://p/101.m4a" });
    expect(matched.outLinks.spotify).toBe("https://open.spotify.com/track/s1");

    const lost = by("s4").item;
    expect(lost).toMatchObject({ kind: "music", title: "Lost Song", creator: "Artist D", year: 2019, imageUrl: "https://img/s4-l.jpg", previewUrl: null });
    expect(lost.externalIds).toEqual({ spotify: "s4" });
    expect(lost.outLinks).toEqual({ spotify: "https://open.spotify.com/track/s4" });

    // top tracks have no time; played / saved ones do. s2 is in both top and recent, so it keeps the played time.
    expect(by("s1").occurredAt).toBeNull();
    expect(by("s2").occurredAt).toBe("2026-10-30T10:00:00.000Z");
    expect(by("s4").occurredAt).toBe("2026-09-01T00:00:00.000Z");

    expect(world.tokenBodies[0]!.get("grant_type")).toBe("refresh_token");
    expect(world.tokenBodies[0]!.get("refresh_token")).toBe("rt-original");
    expect(world.tokenBodies[0]!.get("client_id")).toBe("cid-test");
  });

  it("stores a rotated refresh token encrypted", async () => {
    stubWorld({ newRefresh: "rt-rotated" });
    const listener = await connectedListener();
    await importSpotifyHistory(env, env.DB, listener);
    const stored = (await getListener(env.DB, listener.id))!.spotifyRefreshToken!;
    expect(stored).not.toContain("rt-rotated");
    expect(await decryptSecret(stored, SECRET)).toBe("rt-rotated");
  });

  it("skips an endpoint that fails and keeps the others", async () => {
    stubWorld({ recentStatus: 500 });
    const listener = await connectedListener();
    expect(await importSpotifyHistory(env, env.DB, listener)).toBe(3); // s1, s2, s4
  });

  it("returns 0 when the token cannot be refreshed", async () => {
    stubWorld({ tokenStatus: 400 });
    expect(await importSpotifyHistory(env, env.DB, await connectedListener())).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("clears the stored token on invalid_grant", async () => {
    stubWorld({ tokenStatus: 400 });
    const listener = await connectedListener();
    expect(await importSpotifyHistory(env, env.DB, listener)).toBe(0);
    expect((await getListener(env.DB, listener.id))!.spotifyRefreshToken).toBeNull();
  });

  it("keeps the stored token when the refresh fails for another reason", async () => {
    stubWorld({ tokenStatus: 503 });
    const listener = await connectedListener();
    expect(await importSpotifyHistory(env, env.DB, listener)).toBe(0);
    expect((await getListener(env.DB, listener.id))!.spotifyRefreshToken).not.toBeNull();
  });

  it("clears a stored token that cannot be decrypted", async () => {
    stubWorld();
    const l = await createListener(env.DB);
    const listener = (await updateListener(env.DB, l.id, { spotifyRefreshToken: "garbage.garbage" }))!;
    expect(await importSpotifyHistory(env, env.DB, listener)).toBe(0);
    expect((await getListener(env.DB, listener.id))!.spotifyRefreshToken).toBeNull();
  });

  it("returns 0 for a listener with no stored token", async () => {
    stubWorld();
    expect(await importSpotifyHistory(env, env.DB, await createListener(env.DB))).toBe(0);
  });

  it("ranks the top tracks 1..n across long and short term, and leaves played and saved unranked", async () => {
    stubWorld({ top: [T1, T2], recent: [T3], saved: [T4] });
    const listener = await connectedListener();
    await importSpotifyHistory(env, env.DB, listener);
    const rows = await listHistory(env.DB, listener.id, 50, "rank");
    const rank = (id: string) => rows.find((r) => r.item.externalIds.spotify === id)!.rank;
    expect([rank("s1"), rank("s2"), rank("s3"), rank("s4")]).toEqual([1, 2, null, null]);
  });

  it("a re-import clears the rank of a track that fell out of the top lists", async () => {
    stubWorld({ top: [T1, T2], recent: [], saved: [] });
    const listener = await connectedListener();
    await importSpotifyHistory(env, env.DB, listener);
    vi.unstubAllGlobals();
    stubWorld({ top: [T2], recent: [T1], saved: [] });
    await importSpotifyHistory(env, env.DB, listener);
    const rows = await listHistory(env.DB, listener.id, 50);
    const rank = (id: string) => rows.find((r) => r.item.externalIds.spotify === id)!.rank;
    expect([rank("s1"), rank("s2")]).toEqual([null, 1]);
  });

  const rankOf = async (listenerId: string, spotifyId: string) => (await listHistory(env.DB, listenerId, 50)).find((r) => r.item.externalIds.spotify === spotifyId)!.rank;

  it("clears the old ranks when a re-import succeeds and finds nothing", async () => {
    stubWorld({ top: [T1, T2], recent: [], saved: [] });
    const listener = await connectedListener();
    await importSpotifyHistory(env, env.DB, listener);
    expect(await rankOf(listener.id, "s1")).toBe(1);
    vi.unstubAllGlobals();
    stubWorld({ top: [], recent: [], saved: [] });
    expect(await importSpotifyHistory(env, env.DB, listener)).toBe(0);
    expect([await rankOf(listener.id, "s1"), await rankOf(listener.id, "s2")]).toEqual([null, null]);
  });

  it("keeps the old ranks when the top lists could not be read", async () => {
    stubWorld({ top: [T1, T2], recent: [], saved: [] });
    const listener = await connectedListener();
    await importSpotifyHistory(env, env.DB, listener);
    vi.unstubAllGlobals();
    stubWorld({ topStatus: 500, recent: [], saved: [] });
    expect(await importSpotifyHistory(env, env.DB, listener)).toBe(0);
    expect([await rankOf(listener.id, "s1"), await rankOf(listener.id, "s2")]).toEqual([1, 2]);
  });

  it("takes 20 long-term, 10 short-term, 10 recent and fills the rest from saved, 40 at most", async () => {
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i): Fake => ({ id: `${p}${i}`, name: `${p} ${i}`, artist: "Artist" }));
    const long = many("l", 30);
    stubWorld({ top: long, recent: many("r", 15), saved: many("v", 30), itunes: [] });
    const listener = await connectedListener();
    expect(await importSpotifyHistory(env, env.DB, listener)).toBe(40);
    const rows = await listHistory(env.DB, listener.id, 100, "rank");
    expect(rows).toHaveLength(40);
    // the stub serves the same top list for both ranges: long takes l0..l19, short continues with l20..l29
    expect(rows.filter((r) => r.rank !== null).map((r) => r.rank)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(rows.filter((r) => r.rank === null)).toHaveLength(10);
  });
});

describe("spotify routes", () => {
  it("shows a not-configured page when there is no client id", async () => {
    mutable.SPOTIFY_CLIENT_ID = "";
    const res = await SELF.fetch(`${BASE}/auth/spotify`, { redirect: "manual", headers: { cookie: await signedInSession() } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(t("spotify.notConfigured"));
  });

  it("GET /auth/spotify sets the pkce cookie and redirects to spotify", async () => {
    const res = await SELF.fetch(`${BASE}/auth/spotify`, { redirect: "manual", headers: { cookie: await signedInSession() } });
    expect(res.status).toBe(302);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/dfm_pkce=[\w-]+\.[\w-]{43,128}\.[0-9a-f-]{36}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain("Path=/auth/spotify");
    expect(cookie).toContain("Max-Age=600");
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://accounts.spotify.com");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    const [state, verifier] = decodeURIComponent(cookie.match(/dfm_pkce=([^;]+)/)![1]!).split(".");
    expect(loc.searchParams.get("state")).toBe(state);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(loc.searchParams.get("code_challenge")).toBe(challenge);
  });

  async function begin() {
    const session = await signedInSession();
    const res = await SELF.fetch(`${BASE}/auth/spotify`, { redirect: "manual", headers: { cookie: session } });
    const pkce = (res.headers.get("set-cookie") ?? "").match(/dfm_pkce=[^;]+/)![0];
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    return { session, pkce, state };
  }
  const callback = (qs: string, cookie: string) => SELF.fetch(`${BASE}/auth/spotify/callback?${qs}`, { redirect: "manual", headers: { cookie } });

  it("sends an anonymous listener to sign in instead of importing at the callback", async () => {
    const { pkce, state } = await begin();
    const anonymous = (await newSession()).split(";")[0]!;
    const res = await callback(`code=abc&state=${state}`, `${anonymous}; ${pkce}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/auth\/google\?next=/);
  });

  it("does not save the token to a listener other than the one who started the flow", async () => {
    const world = stubWorld({ newRefresh: "rt-from-spotify" });
    const { pkce, state } = await begin();
    const other = await signedInSession("Other");
    const res = await callback(`code=the-code&state=${state}`, `${other}; ${pkce}`);
    expect(res.status).toBe(400);
    expect(world.tokenBodies).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners WHERE spotify_refresh_token IS NOT NULL").first<{ n: number }>())!.n).toBe(0);
  });

  it("rejects a pkce cookie from before the listener was part of it", async () => {
    const { session, pkce, state } = await begin();
    const old = pkce.split(".").slice(0, 2).join(".");
    expect((await callback(`code=abc&state=${state}`, `${session}; ${old}`)).status).toBe(400);
  });

  it("rejects a callback whose state does not match", async () => {
    const { session, pkce } = await begin();
    const res = await callback("code=abc&state=wrong", `${session}; ${pkce}`);
    expect(res.status).toBe(400);
  });

  it("rejects a callback with no pkce cookie", async () => {
    const { session, state } = await begin();
    expect((await callback(`code=abc&state=${state}`, session)).status).toBe(400);
  });

  it("goes back to settings when the person denies access", async () => {
    const { session, pkce, state } = await begin();
    const res = await callback(`error=access_denied&state=${state}`, `${session}; ${pkce}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
  });

  it("exchanges the code, stores the token encrypted, imports history and lands on /put", async () => {
    const world = stubWorld({ newRefresh: "rt-from-spotify" });
    const { session, pkce, state } = await begin();
    const res = await callback(`code=the-code&state=${state}`, `${session}; ${pkce}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/put?imported=1");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/dfm_pkce=;|dfm_pkce=; /);

    const exchange = world.tokenBodies[0]!;
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("client_id")).toBe("cid-test");
    expect(exchange.get("redirect_uri")).toBe(`${env.PUBLIC_ORIGIN}/auth/spotify/callback`);
    expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);

    const row = await env.DB.prepare("SELECT id, spotify_refresh_token AS tok FROM listeners").first<{ id: string; tok: string }>();
    expect(row!.tok).not.toContain("rt-from-spotify");
    expect(await decryptSecret(row!.tok, SECRET)).toBe("rt-from-spotify");
    expect(await listHistory(env.DB, row!.id, 50)).toHaveLength(4);
  });

  it("sends the person to settings when the import yields nothing", async () => {
    stubWorld({ top: [], recent: [], saved: [] });
    const { session, pkce, state } = await begin();
    const res = await callback(`code=ok&state=${state}`, `${session}; ${pkce}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings?spotify=failed");
  });

  it("does not store a token when the exchange fails", async () => {
    stubWorld({ tokenStatus: 400 });
    const { session, pkce, state } = await begin();
    const res = await callback(`code=bad&state=${state}`, `${session}; ${pkce}`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain(t("spotify.failed"));
    expect((await env.DB.prepare("SELECT spotify_refresh_token AS tok FROM listeners").first())?.tok).toBeNull();
  });
});
