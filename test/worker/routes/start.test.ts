import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listHistory } from "../../../src/worker/db/history";
import { insertLetter, listLettersByListener } from "../../../src/worker/db/letters";
import { t } from "../../../src/worker/i18n/t";
import { okReply, stubAnthropic } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { json, stubFetch } from "../../helpers/fetch";
import { letterDraft } from "../db/helpers";
import { BASE, get, signedInSession, postForm } from "./helpers";

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;

const track = (id: number, name: string) => ({ trackId: id, trackName: name, artistName: "Someone", releaseDate: "2001-01-01T00:00:00Z" });
/** iTunes answers only for the titles it knows; everything else (books, film, anything unmatched) is empty. */
const stubSearch = (known: Record<string, number>) =>
  stubFetch([
    [
      "https://itunes.apple.com/search",
      (url) => {
        const term = new URL(url).searchParams.get("term") ?? "";
        return json({ results: term in known ? [track(known[term]!, term)] : [] });
      },
    ],
    ["https://www.googleapis.com/books", () => json({ items: [] })],
  ]);

const verdict = (input: unknown) => ({ content: [{ type: "tool_use", id: "j", name: "judge_letter", input }] });

beforeEach(async () => {
  await resetDb(env.DB);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /start", () => {
  it("shows three favourite fields, each with an optional one-liner", async () => {
    const html = await (await get("/start", await signedInSession())).text();
    expect(html).toContain(t("start.title"));
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/start"/);
    for (const n of [1, 2, 3]) {
      expect(html).toContain(`name="fav${n}"`);
      expect(html).toContain(`name="note${n}"`);
    }
    expect(html).not.toContain('name="fav4"');
  });
});

describe("POST /start", () => {
  it("registers three titles as manual history and goes to my station", async () => {
    stubSearch({ 曲A: 1, 曲B: 2, 曲C: 3 });
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "曲A", fav2: "曲B", fav3: "曲C" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/stations/mine");
    const rows = await listHistory(env.DB, idOf(cookie), 10);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "manual")).toBe(true);
    expect(rows.map((r) => r.item.title).sort()).toEqual(["曲A", "曲B", "曲C"]);
  });

  it("never asks YouTube, even with a key set (its quota is for the send page's search)", async () => {
    const { calls } = stubSearch({ 曲A: 1 });
    (env as { YOUTUBE_API_KEY: string }).YOUTUBE_API_KEY = "YT";
    try {
      const res = await postForm("/start", await signedInSession(), { fav1: "曲A", fav2: "存在しない何か", fav3: "" });
      expect(res.status).toBe(303);
    } finally {
      (env as { YOUTUBE_API_KEY: string }).YOUTUBE_API_KEY = "";
    }
    expect(calls().length).toBeGreaterThan(0);
    expect(calls().some((u) => u.includes("/youtube/"))).toBe(false);
  });

  it("goes on with the rest when one field cannot be resolved", async () => {
    stubSearch({ 曲A: 1, 曲C: 3 });
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "曲A", fav2: "存在しない何か", fav3: "曲C" });
    expect(res.status).toBe(303);
    expect((await listHistory(env.DB, idOf(cookie), 10)).map((r) => r.item.title).sort()).toEqual(["曲A", "曲C"]);
  });

  it("answers 422 with the form and a hint when none can be resolved, storing nothing", async () => {
    stubSearch({});
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "ない1", fav2: "ない2", fav3: "" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain(t("start.none"));
    expect(html).toContain(t("start.hint"));
    expect(html).toContain(`placeholder="${t("start.favoritePlaceholder")}"`);
    expect(html).toContain('value="ない1"');
    expect(html).toMatch(/name="fav3"/);
    expect(await listHistory(env.DB, idOf(cookie), 10)).toHaveLength(0);
  });

  it("answers 422 when every field is empty", async () => {
    stubSearch({});
    const res = await postForm("/start", await signedInSession(), { fav1: "", fav2: " ", fav3: "" });
    expect(res.status).toBe(422);
  });

  it("resolves a url first, and does not search for text that is a failed url", async () => {
    const stub = stubFetch([
      ["https://itunes.apple.com/lookup", () => json({ results: [track(9, "Url Song")] })],
      ["https://itunes.apple.com/search", () => json({ results: [track(9, "Url Song")] })],
    ]);
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "https://music.apple.com/jp/album/x/1?i=9", fav2: "https://example.invalid/nothing", fav3: "" });
    expect(res.status).toBe(303);
    expect((await listHistory(env.DB, idOf(cookie), 10)).map((r) => r.item.title)).toEqual(["Url Song"]);
    expect(stub.calls().some((u) => u.startsWith("https://itunes.apple.com/search") && u.includes("example.invalid"))).toBe(false);
  });

  it("registers one history row when two fields name the same work", async () => {
    stubSearch({ 曲A: 1 });
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "曲A", fav2: "曲A", fav3: "" });
    expect(res.status).toBe(303);
    expect(await listHistory(env.DB, idOf(cookie), 10)).toHaveLength(1);
  });

  it("takes a url without a scheme as a url, and never searches a blocked one", async () => {
    const stub = stubFetch([
      ["https://itunes.apple.com/lookup", () => json({ results: [track(9, "Url Song")] })],
      ["https://itunes.apple.com/search", () => json({ results: [track(5, "Searched")] })],
    ]);
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "music.apple.com/jp/album/x/1?i=9", fav2: "http://localhost/x", fav3: "" });
    expect(res.status).toBe(303);
    expect((await listHistory(env.DB, idOf(cookie), 10)).map((r) => r.item.title)).toEqual(["Url Song"]);
    expect(stub.calls().some((u) => u.startsWith("https://itunes.apple.com/search"))).toBe(false);
  });

  it("keeps an item only registered here off the home page until a public letter is on it", async () => {
    stubSearch({ 曲A: 1 });
    const cookie = await signedInSession();
    await postForm("/start", cookie, { fav1: "曲A" });
    // A listener who has started is no longer new, so the page is the plain home.
    expect(await (await get("/", cookie)).text()).not.toContain("いま届いているお便り");
    const [row] = await listHistory(env.DB, idOf(cookie), 1);
    await insertLetter(env.DB, letterDraft(row!.itemId));
    expect(await (await get("/", cookie)).text()).toContain("いま届いているお便り");
  });

  it("puts a one-liner through the letter pipeline, stored with only its outer spaces trimmed, and skips a rejected one", async () => {
    const create = stubAnthropic();
    // stubAnthropic replaces fetch, so route the search hosts to a second stub and keep Anthropic on the first.
    const anthropicFetch = globalThis.fetch;
    const searchFetch = stubSearch({ 曲A: 1, 曲B: 2 });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith("https://api.anthropic.com") ? anthropicFetch(input, init) : searchFetch.fn(input, init);
    });
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "sk-test";
    create.mockImplementation((req) => (String(req.messages?.[0]?.content).includes("買ってね") ? verdict({ ok: false, reason: "ad" }) : okReply(req)));
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "曲A", note1: "  中学の頃、毎日聴いていた ", fav2: "曲B", note2: "買ってね" });
    expect(res.status).toBe(303);
    expect(await listHistory(env.DB, idOf(cookie), 10)).toHaveLength(2);
    const letters = await listLettersByListener(env.DB, idOf(cookie));
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ body: "中学の頃、毎日聴いていた", bodyJa: "中学の頃、毎日聴いていた", status: "public" });
  });

  it("does not block the start when the judgement service is down", async () => {
    stubSearch({ 曲A: 1 });
    (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "";
    const cookie = await signedInSession();
    const res = await postForm("/start", cookie, { fav1: "曲A", note1: "好きでした" });
    expect(res.status).toBe(303);
    expect(await listHistory(env.DB, idOf(cookie), 10)).toHaveLength(1);
  });
});

describe("GET /episodes/new", () => {
  it("does not exist: a GET never creates an episode", async () => {
    const cookie = await signedInSession();
    const res = await SELF.fetch(`${BASE}/episodes/new`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(404);
  });
});

describe("home and bookmarklet", () => {
  it("sends a brand-new listener from the home page to /start", async () => {
    const html = await (await get("/", await signedInSession())).text();
    expect(html).not.toMatch(/<form[^>]*action="\/episodes"/);
    expect(html).toMatch(/好きなものを 3 つ送ると、あなたの好みに近いお便りが流れてきます。<a href="\/start">始める<\/a>/);
  });

  it("puts the bookmarklet itself on /put and a link to it on /settings", async () => {
    const cookie = await signedInSession();
    expect(await (await get("/put", cookie)).text()).toContain('href="javascript:location.href=');
    const settings = await (await get("/settings", cookie)).text();
    expect(settings).toContain('href="/bookmarklet"');
    expect(settings).toContain(t("settings.bookmarklet"));
  });
});
