import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupItunes, searchItunes } from "../../../src/worker/resolve/itunes";
import { json, stubFetch } from "../../helpers/fetch";

const track = {
  wrapperType: "track",
  trackId: 1669547856,
  trackName: "Blue in Green",
  artistName: "Miles Davis",
  previewUrl: "https://audio-ssl.itunes.apple.com/p.m4a",
  artworkUrl100: "https://is1.mzstatic.com/image/100x100bb.jpg",
  trackViewUrl: "https://music.apple.com/jp/album/x/1?i=1669547856",
  releaseDate: "1959-08-17T07:00:00Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("itunes", () => {
  it("searchItunes maps results to music drafts with 600x600 artwork", async () => {
    const { calls, fn } = stubFetch([["https://itunes.apple.com/search", () => json({ results: [track] })]]);
    const drafts = await searchItunes("blue in green miles");
    expect(drafts).toEqual([
      {
        kind: "music",
        title: "Blue in Green",
        creator: "Miles Davis",
        year: 1959,
        imageUrl: "https://is1.mzstatic.com/image/600x600bb.jpg",
        previewUrl: "https://audio-ssl.itunes.apple.com/p.m4a",
        outLinks: { apple: "https://music.apple.com/jp/album/x/1?i=1669547856" },
        externalIds: { itunes: "1669547856" },
      },
    ]);
    expect(calls()).toEqual([
      "https://itunes.apple.com/search?term=blue+in+green+miles&media=music&entity=song&limit=5&country=JP",
    ]);
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("DococaFM/0.1 (+https://dococa.fm)");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("searchItunes tolerates missing optional fields", async () => {
    stubFetch([["https://itunes.apple.com/search", () => json({ results: [{ trackId: 1, trackName: "T", artistName: "A" }] })]]);
    expect(await searchItunes("t")).toEqual([
      { kind: "music", title: "T", creator: "A", year: null, imageUrl: null, previewUrl: null, outLinks: {}, externalIds: { itunes: "1" } },
    ]);
  });

  it("returns [] on non-2xx or malformed bodies", async () => {
    stubFetch([["https://itunes.apple.com/search", () => new Response("boom", { status: 500 })]]);
    expect(await searchItunes("x")).toEqual([]);
    stubFetch([["https://itunes.apple.com/search", () => json({ nope: true })]]);
    expect(await searchItunes("x")).toEqual([]);
  });

  it("lookupItunes fetches by id and returns the track", async () => {
    const { calls } = stubFetch([["https://itunes.apple.com/lookup", () => json({ results: [track] })]]);
    const draft = await lookupItunes("1669547856");
    expect(draft?.externalIds).toEqual({ itunes: "1669547856" });
    expect(calls()).toEqual(["https://itunes.apple.com/lookup?id=1669547856&country=JP"]);
  });

  it("lookupItunes returns null when nothing is found", async () => {
    stubFetch([["https://itunes.apple.com/lookup", () => json({ results: [] })]]);
    expect(await lookupItunes("1")).toBeNull();
  });
});
