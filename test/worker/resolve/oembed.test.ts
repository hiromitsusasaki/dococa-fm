import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOembed } from "../../../src/worker/resolve/oembed";
import { json, stubFetch } from "../../helpers/fetch";

afterEach(() => vi.unstubAllGlobals());

describe("fetchOembed", () => {
  it("spotify: hits open.spotify.com/oembed", async () => {
    const { calls } = stubFetch([["https://open.spotify.com/oembed", () => json({ title: "Song", thumbnail_url: "https://i.scdn.co/t.jpg" })]]);
    const url = "https://open.spotify.com/track/abc";
    expect(await fetchOembed("spotify", url)).toEqual({ title: "Song", author: null, thumbnail: "https://i.scdn.co/t.jpg" });
    expect(calls()).toEqual([`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`]);
  });

  it("youtube: hits youtube.com/oembed with format=json and returns author", async () => {
    const { calls } = stubFetch([
      ["https://www.youtube.com/oembed", () => json({ title: "Vid", author_name: "Chan", thumbnail_url: "https://i.ytimg.com/x.jpg" })],
    ]);
    const url = "https://youtu.be/dQw4w9WgXcQ";
    expect(await fetchOembed("youtube", url)).toEqual({ title: "Vid", author: "Chan", thumbnail: "https://i.ytimg.com/x.jpg" });
    expect(calls()).toEqual([`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`]);
  });

  it("returns null on non-2xx or a body without title", async () => {
    stubFetch([["https://open.spotify.com/oembed", () => new Response("", { status: 404 })]]);
    expect(await fetchOembed("spotify", "https://open.spotify.com/track/x")).toBeNull();
    stubFetch([["https://open.spotify.com/oembed", () => json({})]]);
    expect(await fetchOembed("spotify", "https://open.spotify.com/track/x")).toBeNull();
  });
});
