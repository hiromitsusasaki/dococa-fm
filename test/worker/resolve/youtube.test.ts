import { afterEach, describe, expect, it, vi } from "vitest";
import { searchYouTube } from "../../../src/worker/resolve/youtube";
import { json, stubFetch } from "../../helpers/fetch";

afterEach(() => vi.unstubAllGlobals());

const video = (id: string, title: string, channelTitle = "Miles Davis - Topic") => ({
  id: { kind: "youtube#video", videoId: id },
  snippet: { title, channelTitle, thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } } },
});

describe("searchYouTube", () => {
  it("asks search.list for five videos and maps them to video drafts with the watch link", async () => {
    const { calls, fn } = stubFetch([["https://www.googleapis.com/youtube/v3/search", () => json({ items: [video("abc123", "Blue in Green")] })]]);
    expect(await searchYouTube("blue in green", "YT-KEY")).toEqual([
      {
        kind: "video",
        title: "Blue in Green",
        creator: "Miles Davis - Topic",
        year: null,
        imageUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
        previewUrl: null,
        outLinks: { youtube: "https://www.youtube.com/watch?v=abc123" },
        externalIds: { youtube: "abc123" },
      },
    ]);
    const url = new URL(calls()[0]!);
    expect(url.searchParams.get("part")).toBe("snippet");
    expect(url.searchParams.get("type")).toBe("video");
    expect(url.searchParams.get("maxResults")).toBe("5");
    expect(url.searchParams.get("q")).toBe("blue in green");
    // The key travels in a header, so it never appears in a url that could be logged.
    expect(calls()[0]).not.toContain("YT-KEY");
    expect(((fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("YT-KEY");
  });

  it("unescapes the html entities the api puts in titles", async () => {
    stubFetch([["https://www.googleapis.com/youtube/", () => json({ items: [video("x1", "Don&#39;t Know Why &amp; More", "A &quot;B&quot;")] })]]);
    const [d] = await searchYouTube("q", "K");
    expect(d).toMatchObject({ title: "Don't Know Why & More", creator: 'A "B"' });
  });

  it("asks nothing without a key, skips entries without an id, and gives [] on non-2xx", async () => {
    const { fn } = stubFetch([]);
    expect(await searchYouTube("q", "")).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
    stubFetch([["https://www.googleapis.com/youtube/", () => json({ items: [{ id: { kind: "youtube#channel" }, snippet: { title: "chan" } }, video("v", "T")] })]]);
    expect((await searchYouTube("q", "K")).map((d) => d.externalIds.youtube)).toEqual(["v"]);
    stubFetch([["https://www.googleapis.com/youtube/", () => json({ error: {} }, 403)]]);
    expect(await searchYouTube("q", "K")).toEqual([]);
  });
});
