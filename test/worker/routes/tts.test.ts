import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, setLetterStatus } from "../../../src/worker/db/letters";
import type { Episode } from "../../../src/worker/types";
import { resetDb } from "../../helpers/db";
import { json, stubFetch } from "../../helpers/fetch";
import { itemDraft, letterDraft } from "../db/helpers";
import { newSession } from "./helpers";

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;
const report = { verbatim: true, sources: true, topical: true, pii: true, details: [] };
const GOOGLE = "https://texttospeech.googleapis.com/v1/text:synthesize";
const keyed = { ...env, GOOGLE_TTS_API_KEY: "k-test" };

/** Global lines: 0 dj, 1 preview, 2 letter, 3 dj (second segment). */
async function episodeFor(listenerId: string, cloudTts: boolean, verified = true): Promise<Episode> {
  const item = await insertItem(env.DB, itemDraft());
  const stored = await insertLetter(env.DB, letterDraft(item.id, { body: "お便りです", bodyJa: "お便りです", radioName: "しずく", place: "松本" }));
  const letter = { type: "letter" as const, letterId: stored.id, text: "お便りです", radioName: "しずく", place: "松本", kind: "letter" as const, sourceUrl: null, sourceAuthor: null };
  return insertEpisode(env.DB, {
    listenerId,
    cloudTts,
    verified,
    report,
    segments: [
      { itemId: "a", slot: "near", lines: [{ type: "dj", text: "こんばんは" }, { type: "preview", url: "https://p/a.mp3", seconds: 30 }, letter] },
      { itemId: "b", slot: "far", lines: [{ type: "dj", text: "つぎの曲です" }] },
    ],
  });
}

const call = (path: string, cookie: string, e: object = keyed) => app.request(path, { headers: { cookie } }, e);
const audio = btoa(String.fromCharCode(1, 2, 3));

beforeEach(() => resetDb(env.DB));
afterEach(() => vi.unstubAllGlobals());

describe("GET /tts", () => {
  async function setup(cloudTts = true, verified = true) {
    const cookie = await newSession();
    const me = idOf(cookie);
    const ep = await episodeFor(me, cloudTts, verified);
    return { cookie, me, ep };
  }

  it("synthesizes once, stores in R2 and serves the second request from R2", async () => {
    const { cookie, ep } = await setup();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    const first = await call(`/tts?episode=${ep.id}&line=3`, cookie);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(first.headers.get("cache-control")).toBe("private, max-age=86400");
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fn.mock.calls[0]![1]?.body)).input.text).toBe("つぎの曲です");
    expect(await env.BUCKET.get(`tts/${ep.id}/3.mp3`)).not.toBeNull();

    const second = await call(`/tts?episode=${ep.id}&line=3`, cookie);
    expect(second.status).toBe(200);
    expect([...new Uint8Array(await second.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reads a letter line by its global index", async () => {
    const { cookie, ep } = await setup();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=2`, cookie)).status).toBe(200);
    expect(JSON.parse(String(fn.mock.calls[0]![1]?.body)).input.text).toBe("お便りです");
  });

  it("answers 404 for another listener's episode", async () => {
    const { ep } = await setup();
    const other = await newSession();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=0`, other)).status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 404 when the episode did not get cloud tts, or does not exist", async () => {
    const { cookie, ep } = await setup(false);
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=0`, cookie)).status).toBe(404);
    expect((await call("/tts?episode=nope&line=0", cookie)).status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 404 for an unverified episode", async () => {
    const { cookie, ep } = await setup(true, false);
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=0`, cookie)).status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 404 for a letter rejected since, and for the segment that only read it", async () => {
    const { cookie, ep } = await setup();
    const letterId = (ep.segments[0]!.lines[2] as { letterId: string }).letterId;
    await setLetterStatus(env.DB, letterId, "rejected");
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=2`, cookie)).status).toBe(404);
    expect((await call(`/tts?episode=${ep.id}&line=0`, cookie)).status).toBe(404);
    expect((await call(`/tts?episode=${ep.id}&line=3`, cookie)).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("answers 400 for a preview line, an out-of-range line and bad parameters", async () => {
    const { cookie, ep } = await setup();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=1`, cookie)).status).toBe(400);
    expect((await call(`/tts?episode=${ep.id}&line=9`, cookie)).status).toBe(400);
    expect((await call(`/tts?episode=${ep.id}&line=x`, cookie)).status).toBe(400);
    expect((await call(`/tts?episode=${ep.id}&line=-1`, cookie)).status).toBe(400);
    expect((await call(`/tts?episode=${ep.id}`, cookie)).status).toBe(400);
    expect((await call(`/tts?line=0`, cookie)).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 503 when there is no key and nothing cached", async () => {
    const { cookie, ep } = await setup();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    const res = await call(`/tts?episode=${ep.id}&line=0`, cookie, { ...env, GOOGLE_TTS_API_KEY: "" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "tts unavailable" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers 502 when the API fails, and caches nothing", async () => {
    const { cookie, ep } = await setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch([[GOOGLE, () => json({}, 500)]]);
    expect((await call(`/tts?episode=${ep.id}&line=0`, cookie)).status).toBe(502);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("k-test");
    expect(await env.BUCKET.get(`tts/${ep.id}/0.mp3`)).toBeNull();
  });

  it("never logs the key when fetch itself throws", async () => {
    const { cookie, ep } = await setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: string) => {
      throw new TypeError(`failed to fetch ${url}`);
    });
    expect((await call(`/tts?episode=${ep.id}&line=0`, cookie)).status).toBe(502);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("k-test");
  });

  it("makes one Google call for two concurrent requests of the same uncached line", async () => {
    const { cookie, ep } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { fn } = stubFetch([[GOOGLE, async () => {
      await gate;
      return json({ audioContent: audio });
    }]]);
    const both = Promise.all([call(`/tts?episode=${ep.id}&line=3`, cookie), call(`/tts?episode=${ep.id}&line=3`, cookie)]);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await both;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([...new Uint8Array(await a.arrayBuffer())]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(await b.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(fn).toHaveBeenCalledTimes(1);
    // The claim is released once the clip is stored.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tts_claims").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("answers 503 with Retry-After when another request holds the claim and no clip appears", async () => {
    const { cookie, ep } = await setup();
    await env.DB.prepare("INSERT INTO tts_claims (key, created_at) VALUES (?, ?)").bind(`tts/${ep.id}/3.mp3`, Date.now()).run();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    const res = await call(`/tts?episode=${ep.id}&line=3`, cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(fn).not.toHaveBeenCalled();
  }, 15_000);

  it("treats a claim older than a minute as free", async () => {
    const { cookie, ep } = await setup();
    await env.DB.prepare("INSERT INTO tts_claims (key, created_at) VALUES (?, ?)").bind(`tts/${ep.id}/3.mp3`, Date.now() - 61_000).run();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=3`, cookie)).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when Google fails, so the next request may try again", async () => {
    const { cookie, ep } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch([[GOOGLE, () => json({}, 500)]]);
    expect((await call(`/tts?episode=${ep.id}&line=3`, cookie)).status).toBe(502);
    vi.unstubAllGlobals();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect((await call(`/tts?episode=${ep.id}&line=3`, cookie)).status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("limits each listener, then each IP, with a JSON 429", async () => {
    const { cookie, ep } = await setup();
    stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    // RATE_LIMIT_PER_MINUTE=1 scales the buckets down: 3 a minute per listener, 6 per IP.
    const slow = { ...keyed, RATE_LIMIT_PER_MINUTE: "1" };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call(`/tts?episode=${ep.id}&line=0`, cookie, slow)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await call(`/tts?episode=${ep.id}&line=0`, cookie, slow);
    expect(await limited.json()).toEqual({ error: "rate_limited" });

    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const byIp: number[] = [];
    for (let i = 0; i < 7; i++) {
      const fresh = await newSession();
      byIp.push((await app.request(`/tts?episode=${ep.id}&line=0`, { headers: { cookie: fresh, ...ip } }, slow)).status);
    }
    expect(byIp.slice(0, 6).every((s) => s === 404)).toBe(true);
    expect(byIp[6]).toBe(429);
  });

  it("picks the male voice by default and female when configured", async () => {
    const { cookie, ep } = await setup();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    await call(`/tts?episode=${ep.id}&line=0`, cookie);
    await call(`/tts?episode=${ep.id}&line=3`, cookie, { ...keyed, GEMINI_TTS_VOICE: "female" });
    const names = fn.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).voice.name);
    expect(names).toEqual(["Charon", "Kore"]);
  });
});
