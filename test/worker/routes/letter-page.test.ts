import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
import { updateListener } from "../../../src/worker/db/listeners";
import { upsertUnit } from "../../../src/worker/db/units";
import { handOver, leadLine } from "../../../src/worker/program/compose";
import { audioKey } from "../../../src/worker/tts/audio";
import type { Letter } from "../../../src/worker/types";
import { resetBucket } from "../../helpers/bucket";
import { resetDb } from "../../helpers/db";
import { json, stubFetch } from "../../helpers/fetch";
import { makeServiceAccount, primeToken } from "../../helpers/service-account";
import { itemDraft, letterDraft } from "../db/helpers";
import { newSession } from "./helpers";

const ORIGIN = "http://127.0.0.1:5173";
const GOOGLE = "https://texttospeech.googleapis.com/v1/text:synthesize";
const sa = await makeServiceAccount();
const e = { ...env, PUBLIC_ORIGIN: ORIGIN };
const keyed = { ...e, GOOGLE_TTS_SA_JSON: sa.json };
const audio = btoa(String.fromCharCode(1, 2, 3));
const listeners = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM listeners").first<{ n: number }>())!.n;
const get = (path: string, headers: Record<string, string> = {}, en: object = e) => app.request(path, { headers }, en);

beforeEach(async () => {
  await resetDb(env.DB);
  await resetBucket(env.BUCKET);
  await primeToken(sa.json);
});
afterEach(() => vi.unstubAllGlobals());

const BODY = "夜の帰り道にこの曲を聴くと、街の灯りが少しだけ優しく見えます。".repeat(4);

async function shared(over: Partial<Omit<Letter, "id" | "createdAt" | "demo">> = {}) {
  const item = await insertItem(env.DB, itemDraft({ title: "PSYの歌" }));
  const letter = await insertLetter(env.DB, letterDraft(item.id, { body: BODY, bodyJa: BODY, bodyEn: "On the way home at night...", radioName: "しずく", place: "松本", ...over }));
  return { item, letter };
}

async function withUnit(letterId: string, lang: "ja" | "en" = "ja", verified = true) {
  await upsertUnit(env.DB, {
    letterId,
    lang,
    intro: lang === "ja" ? "PSYらしい一曲です。" : "A quiet piece.",
    after: lang === "ja" ? "いいお便りでした。" : "A lovely letter.",
    readings: lang === "ja" ? [{ text: "PSY", reading: "サイ" }] : [],
    verified,
    audioReady: false,
  });
}

const metaOf = (html: string, key: string) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];

describe("GET /letters/:id", () => {
  it("shows the work, the letter verbatim, the reaction forms, the radio link and the player", async () => {
    const { item, letter } = await shared();
    const res = await get(`/letters/${letter.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(item.title);
    expect(html).toContain(BODY);
    expect(html).toContain("しずくさん（松本）");
    expect(html).toContain('name="kind" value="watashimo"');
    expect(html).toContain('name="kind" value="reply"');
    expect(html).toContain(`href="/?letter=${letter.id}"`);
    expect(html).toContain("ラジオで続きを聴く");
    expect(html).toContain(`data-embed="/letters/${letter.id}"`);
    expect(html).toMatch(/src="\/(src\/client\/embed\.tsx|assets\/embed\.js)"/);
  });

  it("puts share links under the letter: its public url and a short text, nothing private, wired by the small share script", async () => {
    const { letter } = await shared();
    const html = await (await get(`/letters/${letter.id}`)).text();
    const url = `${ORIGIN}/letters/${letter.id}`;
    const block = html.match(/<div class="share">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(html.indexOf('<div class="share">')).toBeGreaterThan(html.indexOf('<article class="letter"'));
    expect(html.indexOf('<div class="share">')).toBeLessThan(html.indexOf('class="embed-player"'));
    const x = new URL(block.match(/<a class="pill" href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"));
    expect(x.origin + x.pathname).toBe("https://x.com/intent/post");
    expect([...x.searchParams.keys()].sort()).toEqual(["text", "url"]);
    expect(x.searchParams.get("url")).toBe(url);
    expect(x.searchParams.get("text")).toBe("PSYの歌 · しずくさんのお便り — Dococa FM");
    expect(block).toContain(`data-share="${url}"`);
    expect(block).toContain(`data-copy="${url}"`);
    expect(block).not.toContain("松本");
    expect(html).toMatch(/<script type="module" src="(\/assets\/share-page\.js|\/src\/client\/share-page\.tsx)"><\/script>/);
  });

  it("carries the OGP and the X player card", async () => {
    const { item, letter } = await shared();
    const html = await (await get(`/letters/${letter.id}`)).text();
    expect(metaOf(html, "og:type")).toBe("article");
    expect(metaOf(html, "og:title")).toBe(`${item.title} · しずくさん（松本）`);
    expect(metaOf(html, "og:description")).toBe(Array.from(BODY).slice(0, 100).join(""));
    expect(metaOf(html, "og:image")).toBe("https://example.com/a.jpg");
    expect(metaOf(html, "og:url")).toBe(`${ORIGIN}/letters/${letter.id}`);
    expect(metaOf(html, "twitter:card")).toBe("player");
    expect(metaOf(html, "twitter:player")).toBe(`${ORIGIN}/letters/${letter.id}/player`);
    expect(metaOf(html, "twitter:player:width")).toBe("480");
    expect(metaOf(html, "twitter:player:height")).toBe("200");
    expect(html).not.toContain("twitter:player:stream");
    expect(metaOf(html, "og:audio")).toBeUndefined();
  });

  it("falls back to the key visual, describes in the listener's language and names the first clip already made", async () => {
    const item = await insertItem(env.DB, itemDraft({ imageUrl: null }));
    const letter = await insertLetter(env.DB, letterDraft(item.id, { body: "静かな夜", bodyJa: "静かな夜", bodyEn: "A quiet night" }));
    await withUnit(letter.id);
    await env.BUCKET.put(await audioKey("ja", "male", leadLine(item, "ja").spoken ?? leadLine(item, "ja").text), new Uint8Array([1]));
    const cookie = await newSession();
    await updateListener(env.DB, cookie.split("=")[1]!.split(".")[0]!, { lang: "en" });
    const html = await (await get(`/letters/${letter.id}`, { cookie })).text();
    expect(metaOf(html, "og:image")).toBe(`${ORIGIN}/kv.jpg`);
    expect(metaOf(html, "og:description")).toBe("A quiet night");
    expect(metaOf(html, "og:audio")).toBe(`${ORIGIN}/letters/${letter.id}/audio/0`);
  });

  it.each(["rejected", "withdrawn"] as const)("answers 404 for a %s letter, a reaction, a found voice without its source, an unknown or malformed id", async (status) => {
    const { letter } = await shared();
    await setLetterStatus(env.DB, letter.id, status);
    const { item } = await shared();
    const reaction = await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: letter.id }));
    const found = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: null, sourceAuthor: "someone" }));
    for (const id of [letter.id, reaction.id, found.id, crypto.randomUUID(), "not-a-uuid"]) {
      for (const path of [`/letters/${id}`, `/letters/${id}/player`, `/letters/${id}/lines.json`, `/letters/${id}/audio/3`]) {
        expect((await get(path)).status, path).toBe(404);
      }
    }
  });

  it("shows a found voice with its source", async () => {
    const { item } = await shared();
    const found = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", radioName: "", sourceUrl: "https://www.youtube.com/watch?v=x", sourceAuthor: "@fan" }));
    const html = await (await get(`/letters/${found.id}`)).text();
    expect(html).toContain("@fan");
    expect(html).toContain("https://www.youtube.com/watch?v=x");
  });
});

describe("GET /letters/:id/player", () => {
  it("may be framed anywhere, mints no listener, has no site header and opens the page in the top window", async () => {
    const { item, letter } = await shared();
    const res = await get(`/letters/${letter.id}/player`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors *");
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await listeners()).toBe(0);
    const html = await res.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toContain("site-header");
    expect(html).toContain(item.title);
    expect(html).toContain("しずくさん（松本）");
    expect(html).toContain(`href="/letters/${letter.id}" target="_top"`);
    expect(html).toContain("Dococa FM で聴く");
  });

  it("leaves the rest of the site unframeable, the share page too", async () => {
    const { letter } = await shared();
    for (const path of ["/", `/letters/${letter.id}`, `/letters/${letter.id}/lines.json`]) {
      const res = await get(path);
      expect(res.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
      expect(res.headers.get("content-security-policy"), path).toBeNull();
    }
  });
});

describe("GET /letters/:id/lines.json", () => {
  it("lists lead, intro, hand-over, letter and after in the letter's language, as written", async () => {
    const { item, letter } = await shared();
    await withUnit(letter.id);
    const res = await get(`/letters/${letter.id}/lines.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.json<{ lines: Array<{ n: number; type: string; text: string }> }>();
    expect(body.lines).toEqual([
      { n: 0, type: "dj", text: leadLine(item, "ja").text },
      { n: 1, type: "dj", text: "PSYらしい一曲です。" },
      { n: 2, type: "dj", text: (handOver(letter, "ja") as { text: string }).text },
      { n: 3, type: "letter", text: BODY },
      { n: 4, type: "dj", text: "いいお便りでした。" },
    ]);
    expect(JSON.stringify(body)).not.toContain("サイ");
    expect(await listeners()).toBe(0);
  });

  it("uses the English unit for an English letter", async () => {
    const { letter } = await shared({ lang: "en", body: "Night drive.", bodyJa: "夜のドライブ。", bodyEn: null });
    await withUnit(letter.id, "ja");
    await withUnit(letter.id, "en");
    const { lines } = await (await get(`/letters/${letter.id}/lines.json`)).json<{ lines: Array<{ n: number; text: string }> }>();
    expect(lines.find((l) => l.n === 1)?.text).toBe("A quiet piece.");
    expect(lines.find((l) => l.n === 3)?.text).toBe("Night drive.");
  });

  it("is the hand-over and the letter only without a verified unit", async () => {
    const { letter } = await shared();
    await withUnit(letter.id, "ja", false);
    const { lines } = await (await get(`/letters/${letter.id}/lines.json`)).json<{ lines: Array<{ n: number }> }>();
    expect(lines.map((l) => l.n)).toEqual([2, 3]);
  });
});

describe("GET /letters/:id/audio/:n", () => {
  it("serves a clip from R2 publicly, without a listener", async () => {
    const { letter } = await shared();
    await env.BUCKET.put(await audioKey("ja", "male", BODY), new Uint8Array([7, 8]));
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    const res = await get(`/letters/${letter.id}/audio/3`, {}, keyed);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([7, 8]);
    expect(fn).not.toHaveBeenCalled();
    expect(await listeners()).toBe(0);
  });

  it("serves a dj line's clip under the key of its spoken text, and never synthesises a miss", async () => {
    const { letter } = await shared();
    await withUnit(letter.id);
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await get(`/letters/${letter.id}/audio/1`, {}, keyed)).status).toBe(404);
    expect((await get(`/letters/${letter.id}/audio/3`, {}, keyed)).status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
    expect(await env.BUCKET.get(await audioKey("ja", "male", "サイらしい一曲です。"))).toBeNull();
    await env.BUCKET.put(await audioKey("ja", "male", "サイらしい一曲です。"), new Uint8Array([5]));
    const res = await get(`/letters/${letter.id}/audio/1`, {}, keyed);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([5]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 404 for a line the letter does not have", async () => {
    const { letter } = await shared();
    await env.BUCKET.put(await audioKey("ja", "male", BODY), new Uint8Array([1]));
    for (const n of ["0", "1", "4", "5", "x", "03"]) expect((await get(`/letters/${letter.id}/audio/${n}`, {}, keyed)).status, n).toBe(404);
  });

  it("limits one IP in its own bucket", async () => {
    const { letter } = await shared();
    await env.BUCKET.put(await audioKey("ja", "male", BODY), new Uint8Array([1]));
    // RATE_LIMIT_PER_MINUTE=1 scales the bucket down: 6 a minute per IP.
    const slow = { ...keyed, RATE_LIMIT_PER_MINUTE: "1" };
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await get(`/letters/${letter.id}/audio/3`, { "cf-connecting-ip": "203.0.113.90" }, slow)).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
    expect((await get(`/letters/${letter.id}/audio/3`, { "cf-connecting-ip": "203.0.113.91" }, slow)).status).toBe(200);
  });
});
