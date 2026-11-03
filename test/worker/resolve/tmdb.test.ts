import { afterEach, describe, expect, it, vi } from "vitest";
import { searchTmdb } from "../../../src/worker/resolve/tmdb";
import { json, stubFetch } from "../../helpers/fetch";

afterEach(() => vi.unstubAllGlobals());

describe("searchTmdb", () => {
  it("sends the bearer token and maps results to film drafts", async () => {
    const { calls, fn } = stubFetch([
      [
        "https://api.themoviedb.org/3/search/movie",
        () => json({ results: [{ id: 496243, title: "パラサイト 半地下の家族", release_date: "2019-05-30", poster_path: "/p.jpg" }] }),
      ],
    ]);
    expect(await searchTmdb("パラサイト", "KEY")).toEqual([
      {
        kind: "film",
        title: "パラサイト 半地下の家族",
        creator: "",
        year: 2019,
        imageUrl: "https://image.tmdb.org/t/p/w500/p.jpg",
        previewUrl: null,
        outLinks: { tmdb: "https://www.themoviedb.org/movie/496243" },
        externalIds: { tmdb: "496243" },
      },
    ]);
    expect(calls()).toEqual([`https://api.themoviedb.org/3/search/movie?query=${encodeURIComponent("パラサイト")}&language=ja-JP`]);
    const headers = (fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer KEY");
  });

  it("skips silently without a key", async () => {
    const { fn } = stubFetch([]);
    expect(await searchTmdb("x", "")).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("handles missing poster and date, and non-2xx", async () => {
    stubFetch([["https://api.themoviedb.org/", () => json({ results: [{ id: 1, title: "T" }] })]]);
    const [d] = await searchTmdb("t", "K");
    expect(d).toMatchObject({ year: null, imageUrl: null });
    stubFetch([["https://api.themoviedb.org/", () => new Response("", { status: 401 })]]);
    expect(await searchTmdb("t", "K")).toEqual([]);
  });
});
