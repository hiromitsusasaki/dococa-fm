import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanOgpTitle, fetchOgp } from "../../../src/worker/resolve/ogp";
import { html, meta, stubFetch } from "../../helpers/fetch";

afterEach(() => vi.unstubAllGlobals());

describe("fetchOgp", () => {
  it("reads og:title and og:image in either attribute order, property or name, decoding entities", async () => {
    stubFetch([
      [
        "https://example.com/a",
        () =>
          html(`<head>
            <meta content="Tom &amp; Jerry &quot;Q&quot; &#39;s &lt;b&gt;" property="og:title">
            <meta name='og:image' content='/img/x.png'>
          </head>`),
      ],
    ]);
    expect(await fetchOgp("https://example.com/a")).toEqual({
      title: `Tom & Jerry "Q" 's <b>`,
      image: "https://example.com/img/x.png",
    });
  });

  it("returns image null when absent and null when there is no title", async () => {
    stubFetch([["https://example.com/a", () => meta({ "og:title": "T" })], ["https://example.com/b", () => meta({ "og:image": "https://x/y.png" })]]);
    expect(await fetchOgp("https://example.com/a")).toEqual({ title: "T", image: null });
    expect(await fetchOgp("https://example.com/b")).toBeNull();
  });

  it("returns null on non-2xx", async () => {
    stubFetch([["https://example.com/", () => new Response("", { status: 503 })]]);
    expect(await fetchOgp("https://example.com/a")).toBeNull();
  });

  it("only looks at the first 512 KB", async () => {
    const filler = "x".repeat(600 * 1024);
    stubFetch([["https://example.com/", () => html(`<head>${filler}<meta property="og:title" content="late"></head>`)]]);
    expect(await fetchOgp("https://example.com/a")).toBeNull();
  });

  it("sends the user agent and a timeout signal", async () => {
    const { fn } = stubFetch([["https://example.com/", () => meta({ "og:title": "T" })]]);
    await fetchOgp("https://example.com/a");
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("DococaFM/0.1 (+https://dococa.fm)");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("cleanOgpTitle", () => {
  it.each([
    ["filmarks", "映画『Beneath（原題）』の感想・レビュー[14件] | Filmarks", { title: "Beneath（原題）", year: null }],
    ["letterboxd", "Parasite (2019)", { title: "Parasite", year: 2019 }],
    ["netflix", "Watch Demon Slayer: Kimetsu no Yaiba | Netflix", { title: "Demon Slayer: Kimetsu no Yaiba", year: null }],
    ["netflix", "鬼滅の刃 | Netflix (ネットフリックス) 公式サイト", { title: "鬼滅の刃", year: null }],
    ["amazon", "Amazon.co.jp: こころ", { title: "Amazon.co.jp: こころ", year: null }],
  ] as const)("%s: %s", (provider, raw, expected) => {
    expect(cleanOgpTitle(provider, raw)).toEqual(expected);
  });
});
