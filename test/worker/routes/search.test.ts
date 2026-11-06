import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import type { Env } from "../../../src/worker/env";
import { insertItem } from "../../../src/worker/db/items";
import { t } from "../../../src/worker/i18n/t";
import { resetDb } from "../../helpers/db";
import { json, stubFetch } from "../../helpers/fetch";
import { itemDraft } from "../db/helpers";
import { newSession, signedInSession } from "./helpers";

beforeEach(() => resetDb(env.DB));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = { ...env, TMDB_API_KEY: "TMDB", YOUTUBE_API_KEY: "" } as Env;
const search = (q: string, cookie: string, e: Env = base) => app.request(`/put?q=${encodeURIComponent(q)}`, { headers: { cookie } }, e);

const providers = (o: { itunes?: () => Response } = {}): Array<[string, () => Response]> => [
  ["https://itunes.apple.com/search", o.itunes ?? (() => json({ results: [{ trackId: 11, trackName: "Blue in Green", artistName: "Miles Davis", trackViewUrl: "https://music.apple.com/jp/album/x/1?i=11" }] }))],
  ["https://www.googleapis.com/books/", () => json({ items: [{ id: "bk1", volumeInfo: { title: "Blue Book", authors: ["Someone"], infoLink: "https://books.google.co.jp/books?id=bk1" } }] })],
  ["https://api.themoviedb.org/", () => json({ results: [{ id: 77, title: "Blue Film" }] })],
  ["https://www.googleapis.com/youtube/", () => json({ items: [{ id: { videoId: "yt1" }, snippet: { title: "Blue Video", channelTitle: "Chan" } }] })],
];

describe("GET /put?q= (search by title)", () => {
  it("shows an anonymous visitor the sign-in prompt and asks no provider", async () => {
    const { fn } = stubFetch(providers());
    const res = await search("blue", await newSession());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(t("put.searchNeedsSignin"));
    expect(html).toContain(`href="/auth/google?next=${encodeURIComponent("/put")}"`);
    expect(html).not.toContain('name="q"');
    expect(fn).not.toHaveBeenCalled();
  });

  it("searches iTunes, Google Books and TMDB for a signed-in listener and links each hit to the send page", async () => {
    const { calls } = stubFetch(providers());
    const res = await search("blue", await signedInSession());
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const title of ["Blue in Green", "Blue Book", "Blue Film"]) expect(html).toContain(title);
    expect(html).not.toContain("Blue Video");
    expect(calls().some((u) => u.includes("/youtube/"))).toBe(false);
    expect(html).toContain(`/put?url=${encodeURIComponent("https://music.apple.com/jp/album/x/1?i=11").replaceAll("&", "&amp;")}`);
    expect(html).toContain(`/put?url=${encodeURIComponent("https://www.themoviedb.org/movie/77")}`);
    expect(html).toContain('value="blue"');
  });

  it("adds YouTube only when YOUTUBE_API_KEY is set", async () => {
    const { calls } = stubFetch(providers());
    const html = await (await search("blue", await signedInSession(), { ...base, YOUTUBE_API_KEY: "YT" } as Env)).text();
    expect(html).toContain("Blue Video");
    expect(html).toContain(`/put?url=${encodeURIComponent("https://www.youtube.com/watch?v=yt1")}`);
    expect(calls().filter((u) => u.includes("/youtube/"))).toHaveLength(1);
  });

  it("links a hit that is already stored to the stored item", async () => {
    stubFetch(providers());
    const stored = await insertItem(env.DB, itemDraft({ title: "Blue in Green", externalIds: { itunes: "11" } }));
    const html = await (await search("blue", await signedInSession())).text();
    expect(html).toContain(`/put?itemId=${stored.id}`);
  });

  it("still shows the other providers when one throws", async () => {
    stubFetch(providers({ itunes: () => { throw new TypeError("down"); } }));
    const html = await (await search("blue", await signedInSession())).text();
    expect(html).not.toContain("Blue in Green");
    expect(html).toContain("Blue Book");
    expect(html).toContain("Blue Film");
  });

  it("says nothing was found when no provider has a hit", async () => {
    stubFetch([]);
    const html = await (await search("zzz", await signedInSession())).text();
    expect(html).toContain(t("search.none"));
  });

  it("never logs the query", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    stubFetch(providers({ itunes: () => { throw new TypeError("down"); } }));
    await search("secret-words-xyz", await signedInSession());
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-words-xyz");
  });

  it("answers the 21st search in a minute with 429 and the search notice, per listener", async () => {
    stubFetch(providers());
    const cookie = await signedInSession();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await search(`blue ${i}`, cookie)).status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    const limited = await search("blue 21", cookie);
    expect(limited.status).toBe(429);
    expect(await limited.text()).toContain(t("search.tooMany"));
    // The page without a search, and another listener, are not held back.
    expect((await app.request("/put", { headers: { cookie } }, base)).status).toBe(200);
    expect((await search("blue", await signedInSession())).status).toBe(200);
  });

  it("scales the search bucket with RATE_LIMIT_PER_MINUTE", async () => {
    stubFetch(providers());
    const slow = { ...base, RATE_LIMIT_PER_MINUTE: "1" } as Env;
    const cookie = await signedInSession();
    expect((await search("a", cookie, slow)).status).toBe(200);
    expect((await search("b", cookie, slow)).status).toBe(429);
  });
});
