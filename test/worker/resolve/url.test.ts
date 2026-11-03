import { describe, expect, it } from "vitest";
import { isFetchableUrl, parseKnownUrl } from "../../../src/worker/resolve/url";

describe("parseKnownUrl", () => {
  it.each([
    ["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc", { provider: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC" }],
    ["https://open.spotify.com/intl-ja/track/4uLU6hMCjMI75M1A2tKUQC", { provider: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC" }],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3", { provider: "youtube", id: "dQw4w9WgXcQ" }],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", { provider: "youtube", id: "dQw4w9WgXcQ" }],
    ["https://youtu.be/dQw4w9WgXcQ?si=x", { provider: "youtube", id: "dQw4w9WgXcQ" }],
    ["https://music.apple.com/jp/album/blue-in-green/1669547800?i=1669547856", { provider: "apple-music", id: "1669547856" }],
    ["https://www.amazon.co.jp/%E6%9C%AC/dp/4101001014/ref=sr_1_1", { provider: "amazon", id: "4101001014" }],
    ["https://www.amazon.com/Some-Thing/dp/B08N5WRWNW", { provider: "amazon", id: "B08N5WRWNW" }],
    ["https://filmarks.com/movies/70358", { provider: "filmarks", id: "70358" }],
    ["https://letterboxd.com/film/parasite-2019/", { provider: "letterboxd", id: "parasite-2019" }],
    ["https://www.netflix.com/title/81091393", { provider: "netflix", id: "81091393" }],
    ["https://www.netflix.com/jp/title/81091393", { provider: "netflix", id: "81091393" }],
  ])("parses %s", (url, expected) => {
    expect(parseKnownUrl(url)).toEqual(expected);
  });

  it("returns unknown for other hosts, known hosts with unsupported paths, and non-URLs", () => {
    expect(parseKnownUrl("https://example.com/foo")).toEqual({ provider: "unknown" });
    expect(parseKnownUrl("https://open.spotify.com/album/xyz")).toEqual({ provider: "unknown" });
    expect(parseKnownUrl("https://www.youtube.com/@channel")).toEqual({ provider: "unknown" });
    expect(parseKnownUrl("not a url")).toEqual({ provider: "unknown" });
  });

  it("treats an apple music url without ?i= as apple-music with no id", () => {
    expect(parseKnownUrl("https://music.apple.com/jp/album/x/1669547800")).toEqual({ provider: "apple-music" });
  });
});

describe("isFetchableUrl", () => {
  it.each(["https://example.com/x", "http://sub.example.co.jp/a?b=1", "https://foo.localhost.example.com/"])("allows %s", (u) => {
    expect(isFetchableUrl(u)).toBe(true);
  });

  it.each([
    "http://127.0.0.1/x",
    "http://10.0.0.5/",
    "http://[::1]/",
    "http://localhost:5173/",
    "http://app.localhost/",
    "http://foo.internal/",
    "http://printer.local/",
    "http://intranet/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s", (u) => {
    expect(isFetchableUrl(u)).toBe(false);
  });
});
