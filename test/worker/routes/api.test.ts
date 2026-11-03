import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker";
import { json, meta, stubFetch } from "../../helpers/fetch";

afterEach(() => vi.unstubAllGlobals());

describe("temporary resolve routes", () => {
  it("GET /api/resolve returns { item } for a known url", async () => {
    stubFetch([
      ["https://open.spotify.com/oembed", () => json({ title: "Blue in Green", thumbnail_url: "https://i.scdn.co/t.jpg" })],
      ["https://itunes.apple.com/search", () => json({ results: [] })],
    ]);
    const url = "https://open.spotify.com/track/abc";
    const res = await app.request(`/api/resolve?url=${encodeURIComponent(url)}`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ item: { kind: "music", title: "Blue in Green", externalIds: { spotify: "abc" } } });
  });

  it("GET /api/resolve returns 404 { item: null } when nothing resolves, 400 without url", async () => {
    stubFetch([["https://example.com/", () => meta({})]]);
    const miss = await app.request(`/api/resolve?url=${encodeURIComponent("https://example.com/x")}`, {}, env);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ item: null });
    expect((await app.request("/api/resolve", {}, env)).status).toBe(400);
  });

  it("GET /api/search returns { items } and defaults kind to any", async () => {
    const { calls } = stubFetch([["https://itunes.apple.com/search", () => json({ results: [{ trackId: 1, trackName: "T", artistName: "A" }] })], ["https://www.googleapis.com/", () => json({})]]);
    const res = await app.request("/api/search?q=hello", {}, { ...env, TMDB_API_KEY: "" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(calls()[0]).toContain("term=hello");
    expect((await app.request("/api/search?q=x&kind=bogus", {}, env)).status).toBe(400);
    expect((await app.request("/api/search", {}, env)).status).toBe(400);
  });
});
