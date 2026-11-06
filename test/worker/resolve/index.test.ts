import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/worker/env";
import { resolveOrCreate, resolveOrCreateMany, resolveUrl, searchByText, type ItemDraft } from "../../../src/worker/resolve";
import { countingD1 } from "../../helpers/d1-count";
import { resetDb } from "../../helpers/db";
import { html, json, meta, stubFetch } from "../../helpers/fetch";

const testEnv = { ...env, TMDB_API_KEY: "KEY" } as Env;
const noTmdbEnv = { ...env, TMDB_API_KEY: "" } as Env;

const itunesTrack = (id: number, name: string, artist = "Miles Davis") => ({
  trackId: id,
  trackName: name,
  artistName: artist,
  previewUrl: `https://audio.example/${id}.m4a`,
  artworkUrl100: `https://img.example/${id}/100x100bb.jpg`,
  trackViewUrl: `https://music.apple.com/jp/album/x/1?i=${id}`,
  releaseDate: "1959-08-17T07:00:00Z",
});
const volume = (id: string, title: string) => ({ id, volumeInfo: { title, authors: ["夏目漱石"], publishedDate: "1914" } });

afterEach(() => vi.unstubAllGlobals());

describe("resolveUrl", () => {
  it("spotify: oembed then itunes search gives a music draft with preview and the spotify link", async () => {
    const url = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";
    const { calls } = stubFetch([
      ["https://open.spotify.com/oembed", () => json({ title: "Blue in Green", thumbnail_url: "https://i.scdn.co/t.jpg" })],
      ["https://itunes.apple.com/search", () => json({ results: [itunesTrack(10, "Blue in Green")] })],
    ]);
    const draft = await resolveUrl(url, testEnv);
    expect(draft).toMatchObject({
      kind: "music",
      title: "Blue in Green",
      creator: "Miles Davis",
      year: 1959,
      imageUrl: "https://img.example/10/600x600bb.jpg",
      previewUrl: "https://audio.example/10.m4a",
      outLinks: { apple: "https://music.apple.com/jp/album/x/1?i=10", spotify: url },
      externalIds: { itunes: "10", spotify: "4uLU6hMCjMI75M1A2tKUQC" },
    });
    expect(calls()).toEqual([
      `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
      url,
      "https://itunes.apple.com/search?term=Blue+in+Green&media=music&entity=song&limit=5&country=JP",
    ]);
    // The pasted provider's id comes first so it dedupes before an iTunes guess.
    expect(Object.keys(draft!.externalIds)).toEqual(["spotify", "itunes"]);
  });

  it("spotify: still returns a music draft from oembed alone when itunes finds nothing", async () => {
    const url = "https://open.spotify.com/track/abc";
    stubFetch([
      ["https://open.spotify.com/oembed", () => json({ title: "Obscure", thumbnail_url: "https://i.scdn.co/t.jpg" })],
      ["https://itunes.apple.com/search", () => json({ results: [] })],
    ]);
    expect(await resolveUrl(url, testEnv)).toEqual({
      kind: "music",
      title: "Obscure",
      creator: "",
      year: null,
      imageUrl: "https://i.scdn.co/t.jpg",
      previewUrl: null,
      outLinks: { spotify: url },
      externalIds: { spotify: "abc" },
    });
  });

  it("youtube: searches itunes with title and author, keeps the youtube link", async () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const { calls } = stubFetch([
      ["https://www.youtube.com/oembed", () => json({ title: "Song", author_name: "Artist", thumbnail_url: "https://i.ytimg.com/x.jpg" })],
      ["https://itunes.apple.com/search", () => json({ results: [itunesTrack(20, "Song", "Artist")] })],
    ]);
    const draft = await resolveUrl(url, testEnv);
    expect(draft).toMatchObject({ outLinks: { youtube: url }, externalIds: { itunes: "20", youtube: "dQw4w9WgXcQ" } });
    expect(calls()[1]).toContain("term=Song+Artist");
    expect(Object.keys(draft!.externalIds)).toEqual(["youtube", "itunes"]);
  });

  it("youtube: falls back to oembed data when itunes finds nothing", async () => {
    stubFetch([
      ["https://www.youtube.com/oembed", () => json({ title: "Song", author_name: "Artist", thumbnail_url: "https://i.ytimg.com/x.jpg" })],
      ["https://itunes.apple.com/search", () => json({ results: [] })],
    ]);
    expect(await resolveUrl("https://youtu.be/abcdefghijk", testEnv)).toMatchObject({
      kind: "music",
      creator: "Artist",
      previewUrl: null,
      imageUrl: "https://i.ytimg.com/x.jpg",
      externalIds: { youtube: "abcdefghijk" },
    });
  });

  it("apple music: looks up the ?i= id and records the pasted url as the apple link", async () => {
    const url = "https://music.apple.com/jp/album/blue-in-green/1669547800?i=1669547856";
    const { calls } = stubFetch([["https://itunes.apple.com/lookup", () => json({ results: [itunesTrack(1669547856, "Blue in Green")] })]]);
    const draft = await resolveUrl(url, testEnv);
    expect(calls()).toEqual(["https://itunes.apple.com/lookup?id=1669547856&country=JP"]);
    expect(draft).toMatchObject({
      outLinks: { apple: url },
      externalIds: { itunes: "1669547856", "apple-music": "1669547856" },
    });
  });

  it("amazon with an ISBN-10 resolves as a book through google books", async () => {
    const url = "https://www.amazon.co.jp/dp/4101010013";
    const { calls } = stubFetch([["https://www.googleapis.com/books/v1/volumes", () => json({ items: [volume("v1", "こころ")] })]]);
    const draft = await resolveUrl(url, testEnv);
    expect(calls()).toEqual(["https://www.googleapis.com/books/v1/volumes?q=isbn%3A4101010013&maxResults=5"]);
    expect(draft).toMatchObject({
      kind: "book",
      title: "こころ",
      outLinks: { amazon: url },
      externalIds: { "google-books": "v1", isbn: "4101010013", amazon: "4101010013" },
    });
  });

  it("amazon with an ISBN-10 falls back to ogp when google books has nothing", async () => {
    const url = "https://www.amazon.co.jp/dp/4101010013";
    stubFetch([
      ["https://www.googleapis.com/", () => json({ totalItems: 0 })],
      [url, () => meta({ "og:title": "こころ (新潮文庫)", "og:image": "https://m.media-amazon.com/x.jpg" })],
    ]);
    expect(await resolveUrl(url, testEnv)).toMatchObject({
      kind: "book",
      title: "こころ (新潮文庫)",
      imageUrl: "https://m.media-amazon.com/x.jpg",
      externalIds: { isbn: "4101010013", amazon: "4101010013" },
    });
  });

  it("amazon with an ASIN reads ogp then takes the first kind that matches (itunes, books, tmdb)", async () => {
    const url = "https://www.amazon.co.jp/dp/B08N5WRWNW";
    const { calls } = stubFetch([
      [url, () => meta({ "og:title": "Some Album" })],
      ["https://itunes.apple.com/search", () => json({ results: [] })],
      ["https://www.googleapis.com/", () => json({ items: [volume("v9", "Some Album")] })],
      ["https://api.themoviedb.org/", () => json({ results: [{ id: 1, title: "never reached" }] })],
    ]);
    const draft = await resolveUrl(url, testEnv);
    expect(draft).toMatchObject({ kind: "book", outLinks: { amazon: url }, externalIds: { "google-books": "v9", amazon: "B08N5WRWNW" } });
    expect(calls().some((u) => u.startsWith("https://api.themoviedb.org/"))).toBe(false);
  });

  it.each([
    ["filmarks", "https://filmarks.com/movies/70358", "映画『Beneath（原題）』の感想・レビュー[14件] | Filmarks", "Beneath（原題）", null, "70358"],
    ["letterboxd", "https://letterboxd.com/film/parasite-2019/", "Parasite (2019)", "Parasite", 2019, "parasite-2019"],
    ["netflix", "https://www.netflix.com/title/81091393", "Watch Demon Slayer | Netflix", "Demon Slayer", null, "81091393"],
  ])("%s: builds a film draft from ogp", async (provider, url, ogTitle, title, year, id) => {
    stubFetch([[url, () => meta({ "og:title": ogTitle, "og:image": "https://img.example/p.jpg" })]]);
    expect(await resolveUrl(url, testEnv)).toEqual({
      kind: "film",
      title,
      creator: "",
      year,
      imageUrl: "https://img.example/p.jpg",
      previewUrl: null,
      outLinks: { [provider]: url },
      externalIds: { [provider]: id },
    });
  });

  it("unknown url: ogp title is searched across itunes, books, tmdb and the first hit wins", async () => {
    const url = "https://blog.example.com/post";
    const { calls } = stubFetch([
      [url, () => meta({ "og:title": "Parasite" })],
      ["https://itunes.apple.com/search", () => json({ results: [] })],
      ["https://www.googleapis.com/", () => json({})],
      ["https://api.themoviedb.org/", () => json({ results: [{ id: 496243, title: "パラサイト", release_date: "2019-05-30" }] })],
    ]);
    const draft = await resolveUrl(url, testEnv);
    expect(draft).toMatchObject({ kind: "film", externalIds: { tmdb: "496243" } });
    expect(draft?.outLinks).toEqual({ tmdb: "https://www.themoviedb.org/movie/496243" });
    expect(calls()[0]).toBe(url);
  });

  it("resolveUrl_unsupported_returns_null: no ogp, or nothing matches the ogp title", async () => {
    stubFetch([["https://example.com/", () => new Response("<html></html>")]]);
    expect(await resolveUrl("https://example.com/none", testEnv)).toBeNull();

    stubFetch([
      ["https://example.com/", () => meta({ "og:title": "Unfindable" })],
      ["https://itunes.apple.com/", () => json({ results: [] })],
      ["https://www.googleapis.com/", () => json({})],
    ]);
    expect(await resolveUrl("https://example.com/x", noTmdbEnv)).toBeNull();
  });

  describe("spotify artist check", () => {
    const url = "https://open.spotify.com/track/abc";
    const spotifyRoutes = (description: string | null, hits: unknown[]): Array<[string, () => Response]> => [
      ["https://open.spotify.com/oembed", () => json({ title: "Home", thumbnail_url: "https://i.scdn.co/t.jpg" })],
      [url, () => (description ? meta({ "og:title": "Home", "og:description": description }) : new Response("", { status: 500 }))],
      ["https://itunes.apple.com/search", () => json({ results: hits })],
    ];

    it("searches with the artist and picks the hit whose artist matches, not the first hit", async () => {
      const { calls } = stubFetch(
        spotifyRoutes("Edward Sharpe · Up from Below · Song · 2009", [
          itunesTrack(1, "Home", "Michael Bublé"),
          itunesTrack(2, "Home", "Edward Sharpe & The Magnetic Zeros"),
        ]),
      );
      const draft = await resolveUrl(url, testEnv);
      expect(calls()[2]).toContain("term=Home+Edward+Sharpe");
      expect(draft?.externalIds).toEqual({ spotify: "abc", itunes: "2" });
    });

    it("returns the oembed-only draft with the artist as creator when no hit matches", async () => {
      stubFetch(spotifyRoutes("Edward Sharpe · Song · 2009", [itunesTrack(1, "Home", "Michael Bublé")]));
      expect(await resolveUrl(url, testEnv)).toEqual({
        kind: "music",
        title: "Home",
        creator: "Edward Sharpe",
        year: null,
        imageUrl: "https://i.scdn.co/t.jpg",
        previewUrl: null,
        outLinks: { spotify: url },
        externalIds: { spotify: "abc" },
      });
    });

    it("falls back to the title-only search when the page ogp cannot be fetched", async () => {
      const { calls } = stubFetch(spotifyRoutes(null, [itunesTrack(1, "Home", "Michael Bublé")]));
      const draft = await resolveUrl(url, testEnv);
      expect(calls()[2]).toContain("term=Home&");
      expect(draft?.externalIds).toEqual({ spotify: "abc", itunes: "1" });
    });

    it("matches artists case-insensitively, either side containing the other", async () => {
      stubFetch(spotifyRoutes("MILES  DAVIS · Song · 1959", [itunesTrack(5, "Home", "Miles Davis Quintet")]));
      expect((await resolveUrl(url, testEnv))?.externalIds.itunes).toBe("5");
    });
  });

  describe("provider failures inside fallback chains", () => {
    const boom = () => {
      throw new TypeError("timeout");
    };

    it("spotify: itunes throwing still returns the oembed-only draft", async () => {
      stubFetch([
        ["https://open.spotify.com/oembed", () => json({ title: "Obscure", thumbnail_url: "https://i.scdn.co/t.jpg" })],
        ["https://itunes.apple.com/", boom],
      ]);
      expect(await resolveUrl("https://open.spotify.com/track/abc", testEnv)).toMatchObject({
        title: "Obscure",
        imageUrl: "https://i.scdn.co/t.jpg",
        externalIds: { spotify: "abc" },
      });
    });

    it("youtube: itunes throwing still returns the oembed-only draft", async () => {
      stubFetch([
        ["https://www.youtube.com/oembed", () => json({ title: "Vid", author_name: "Chan", thumbnail_url: "https://i.ytimg.com/x.jpg" })],
        ["https://itunes.apple.com/", boom],
      ]);
      expect(await resolveUrl("https://youtu.be/abcdefghijk", testEnv)).toMatchObject({ title: "Vid", creator: "Chan", externalIds: { youtube: "abcdefghijk" } });
    });

    it("apple music: a failing lookup falls through to ogp", async () => {
      const url = "https://music.apple.com/jp/album/x/1?i=77";
      stubFetch([
        ["https://itunes.apple.com/lookup", boom],
        [url, () => meta({ "og:title": "Blue in Green" })],
        ["https://itunes.apple.com/search", () => json({ results: [itunesTrack(77, "Blue in Green")] })],
      ]);
      expect(await resolveUrl(url, testEnv)).toMatchObject({ title: "Blue in Green", outLinks: { apple: url }, externalIds: { "apple-music": "77", itunes: "77" } });
    });

    it("amazon isbn: a failing google books call falls through to the ogp book draft", async () => {
      const url = "https://www.amazon.co.jp/dp/4101010013";
      stubFetch([
        ["https://www.googleapis.com/", boom],
        [url, () => meta({ "og:title": "こころ" })],
      ]);
      expect(await resolveUrl(url, testEnv)).toMatchObject({ kind: "book", title: "こころ", externalIds: { isbn: "4101010013", amazon: "4101010013" } });
    });
  });

  describe("ssrf guard", () => {
    it.each(["http://127.0.0.1/x", "http://[::1]/", "http://localhost:5173/", "http://foo.internal/", "ftp://example.com/"])(
      "%s returns null without fetching",
      async (u) => {
        const { fn } = stubFetch([]);
        expect(await resolveUrl(u, testEnv)).toBeNull();
        expect(fn).not.toHaveBeenCalled();
      },
    );

    it("a public https url proceeds to ogp", async () => {
      const { calls } = stubFetch([["https://example.com/x", () => html("<html></html>")]]);
      expect(await resolveUrl("https://example.com/x", testEnv)).toBeNull();
      expect(calls()).toEqual(["https://example.com/x"]);
    });
  });

  it("returns null for non-urls, http errors and network failures instead of throwing", async () => {
    stubFetch([]);
    expect(await resolveUrl("not a url", testEnv)).toBeNull();
    expect(await resolveUrl("https://open.spotify.com/track/abc", testEnv)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    expect(await resolveUrl("https://open.spotify.com/track/abc", testEnv)).toBeNull();
    expect(await resolveUrl("https://example.com/", testEnv)).toBeNull();
  });
});

describe("resolveUrl for a search result's own link", () => {
  it("tmdb: looks the film up by id, so the chosen film stays a film", async () => {
    const { calls } = stubFetch([["https://api.themoviedb.org/3/movie/496243", () => json({ id: 496243, title: "パラサイト 半地下の家族", release_date: "2019-05-30" })]]);
    const draft = await resolveUrl("http://www.themoviedb.org/movie/496243?utm=x", testEnv);
    expect(draft).toMatchObject({ kind: "film", title: "パラサイト 半地下の家族", year: 2019, externalIds: { tmdb: "496243" } });
    // The canonical link, never the pasted one.
    expect(draft?.outLinks).toEqual({ tmdb: "https://www.themoviedb.org/movie/496243" });
    expect(calls()).toEqual(["https://api.themoviedb.org/3/movie/496243?language=ja-JP"]);
  });

  it("tmdb and google books: an unknown id resolves to nothing, and the page itself is never read", async () => {
    const { calls } = stubFetch([]);
    expect(await resolveUrl("https://www.themoviedb.org/movie/1", testEnv)).toBeNull();
    expect(await resolveUrl("https://books.google.com/books?id=nope", testEnv)).toBeNull();
    expect(calls()).toEqual(["https://api.themoviedb.org/3/movie/1?language=ja-JP", "https://www.googleapis.com/books/v1/volumes/nope"]);
  });

  it("a look-alike books host is not google books: its url never becomes a google-books link", async () => {
    stubFetch([
      ["https://books.google.evil.com/", () => meta({ "og:title": "Blue in Green" })],
      ["https://itunes.apple.com/search", () => json({ results: [itunesTrack(10, "Blue in Green")] })],
    ]);
    const draft = await resolveUrl("https://books.google.evil.com/books?id=abcDEF_1", testEnv);
    expect(draft?.outLinks["google-books"]).toBeUndefined();
    expect(draft?.externalIds["google-books"]).toBeUndefined();
  });

  it("google books: looks the volume up by id, so the chosen book stays a book", async () => {
    const { calls } = stubFetch([["https://www.googleapis.com/books/v1/volumes/abcDEF_1", () => json(volume("abcDEF_1", "こころ"))]]);
    const draft = await resolveUrl("https://books.google.co.jp/books?id=abcDEF_1&dq=x&hl=&source=gbs_api", testEnv);
    expect(draft).toMatchObject({ kind: "book", title: "こころ", creator: "夏目漱石", externalIds: { "google-books": "abcDEF_1" } });
    expect(draft?.outLinks).toEqual({ "google-books": "https://books.google.com/books?id=abcDEF_1" });
    expect(calls()).toEqual(["https://www.googleapis.com/books/v1/volumes/abcDEF_1"]);
  });
});

describe("searchByText", () => {
  const routes: Array<[string, () => Response]> = [
    ["https://itunes.apple.com/search", () => json({ results: [1, 2, 3].map((i) => itunesTrack(i, `Song ${i}`)) })],
    ["https://www.googleapis.com/", () => json({ items: [volume("a", "Book A"), volume("b", "Book B"), volume("c", "Book C")] })],
    ["https://api.themoviedb.org/", () => json({ results: [{ id: 7, title: "Film 7" }] })],
  ];

  it("routes by kind", async () => {
    const { calls } = stubFetch(routes);
    expect((await searchByText("q", "music", testEnv)).map((d) => d.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect((await searchByText("q", "book", testEnv)).map((d) => d.title)).toEqual(["Book A", "Book B", "Book C"]);
    expect((await searchByText("q", "film", testEnv)).map((d) => d.title)).toEqual(["Film 7"]);
    expect(calls().map((u) => new URL(u).host)).toEqual(["itunes.apple.com", "www.googleapis.com", "api.themoviedb.org"]);
  });

  it("any: takes one from itunes, books and tmdb in turn, cut to the limit (5 by default)", async () => {
    stubFetch(routes);
    expect((await searchByText("q", "any", testEnv)).map((d) => d.title)).toEqual(["Song 1", "Book A", "Film 7", "Song 2", "Book B"]);
    expect((await searchByText("q", "any", testEnv, 10)).map((d) => d.title)).toEqual(["Song 1", "Book A", "Film 7", "Song 2", "Book B", "Song 3", "Book C"]);
  });

  it("any asks YouTube only when YOUTUBE_API_KEY is set, and a music search never does", async () => {
    const youtube: [string, () => Response] = ["https://www.googleapis.com/youtube/", () => json({ items: [{ id: { videoId: "v1" }, snippet: { title: "Video 1" } }] })];
    const { calls } = stubFetch([youtube, ...routes]);
    expect((await searchByText("q", "any", testEnv, 10)).map((d) => d.title)).not.toContain("Video 1");
    expect(calls().some((u) => u.includes("/youtube/"))).toBe(false);
    const keyed = { ...testEnv, YOUTUBE_API_KEY: "YT" } as Env;
    expect((await searchByText("q", "any", keyed, 10)).map((d) => d.title)).toEqual(["Song 1", "Book A", "Film 7", "Video 1", "Song 2", "Book B", "Song 3", "Book C"]);
    expect((await searchByText("q", "music", keyed)).map((d) => d.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
  });

  it("film search and any skip tmdb without a key, and a failing provider does not sink the others", async () => {
    const { calls } = stubFetch(routes);
    expect(await searchByText("q", "film", noTmdbEnv)).toEqual([]);
    expect(calls()).toEqual([]);
    stubFetch([
      ["https://itunes.apple.com/search", () => { throw new TypeError("down"); }],
      ...routes.slice(1),
    ]);
    const any = await searchByText("q", "any", testEnv);
    expect(any.map((d) => d.title)).toEqual(["Book A", "Film 7", "Book B", "Book C"]);
  });
});

describe("resolveOrCreate", () => {
  beforeEach(() => resetDb(env.DB));

  const draft = (over: Partial<ItemDraft> = {}): ItemDraft => ({
    kind: "music",
    title: "Blue in Green",
    creator: "Miles Davis",
    year: 1959,
    imageUrl: null,
    previewUrl: null,
    outLinks: {},
    externalIds: { itunes: "10" },
    ...over,
  });
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>())!.n;

  it("returns the existing item when any external id matches, creating only once", async () => {
    const first = await resolveOrCreate(env.DB, draft());
    const second = await resolveOrCreate(env.DB, draft());
    expect(second.id).toBe(first.id);
    expect(await count()).toBe(1);
  });

  it("matches on a later external id when the stored item has no conflicting earlier id", async () => {
    const first = await resolveOrCreate(env.DB, draft({ externalIds: { itunes: "10" } }));
    const again = await resolveOrCreate(env.DB, draft({ externalIds: { spotify: "s9", itunes: "10" } }));
    expect(again.id).toBe(first.id);
    expect(await count()).toBe(1);
  });

  it("dedupes on the pasted provider id before an iTunes guess", async () => {
    const withSpotify = (s: string) => draft({ externalIds: { spotify: s, itunes: "10" } });
    const a = await resolveOrCreate(env.DB, withSpotify("s1"));
    const b = await resolveOrCreate(env.DB, withSpotify("s2"));
    expect(b.id).not.toBe(a.id);
    expect((await resolveOrCreate(env.DB, withSpotify("s1"))).id).toBe(a.id);
    expect(await count()).toBe(2);
  });

  it("creates a new item when nothing matches", async () => {
    await resolveOrCreate(env.DB, draft());
    await resolveOrCreate(env.DB, draft({ externalIds: { itunes: "11" } }));
    expect(await count()).toBe(2);
  });

  it("resolves many drafts in order with one lookup and one batched insert, merging repeats", async () => {
    const old = await resolveOrCreate(env.DB, draft({ externalIds: { itunes: "10" } }));
    const drafts = Array.from({ length: 40 }, (_, n) => draft({ title: `t${n}`, externalIds: { spotify: `s${n}`, itunes: `${100 + n}` } }));
    drafts.push(draft({ externalIds: { itunes: "10" } }), draft({ title: "again", externalIds: { spotify: "s3", itunes: "103" } }));
    const counted = countingD1(env.DB);
    const items = await resolveOrCreateMany(counted.db, drafts);
    expect(items).toHaveLength(42);
    expect(items[40]!.id).toBe(old.id);
    expect(items[41]!.id).toBe(items[3]!.id);
    expect(await count()).toBe(41);
    // 82 id pairs: two lookups; 40 new rows: five multi-row inserts.
    expect(counted.count()).toBeLessThanOrEqual(7);
    const again = await resolveOrCreateMany(env.DB, drafts.slice(0, 2));
    expect(again.map((i) => i.id)).toEqual([items[0]!.id, items[1]!.id]);
  });
});
