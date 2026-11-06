import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioKey, countSynthesizedToday, ensureAudio, voiceOf } from "../../../src/worker/tts/audio";
import { resetBucket } from "../../helpers/bucket";
import { resetDb } from "../../helpers/db";
import { json, stubFetch } from "../../helpers/fetch";
import { makeServiceAccount, primeToken } from "../../helpers/service-account";

const GOOGLE = "https://texttospeech.googleapis.com/v1/text:synthesize";
const sa = await makeServiceAccount();
const keyed = { ...env, GOOGLE_TTS_SA_JSON: sa.json };
const audio = btoa(String.fromCharCode(1, 2, 3));
const line = { text: "こんばんは", lang: "ja" as const, voice: "male" as const };
const rowCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM tts_audio").first<{ n: number }>())!.n;

beforeEach(async () => {
  await resetDb(env.DB);
  await resetBucket(env.BUCKET);
  await primeToken(sa.json);
});
afterEach(() => vi.unstubAllGlobals());

describe("audioKey", () => {
  it("is deterministic and differs by lang, voice and text", async () => {
    const a = await audioKey("ja", "male", "こんばんは");
    expect(a).toMatch(/^tts\/v3\/ja\/male\/[0-9a-f]{64}\.mp3$/);
    expect(await audioKey("ja", "male", "こんばんは")).toBe(a);
    expect(await audioKey("en", "male", "こんばんは")).not.toBe(a);
    expect(await audioKey("ja", "female", "こんばんは")).not.toBe(a);
    expect(await audioKey("ja", "male", "こんばんは。")).not.toBe(a);
  });
});

describe("voiceOf", () => {
  it("is male unless female is configured", () => {
    expect(voiceOf({})).toBe("male");
    expect(voiceOf({ GEMINI_TTS_VOICE: "female" })).toBe("female");
    expect(voiceOf({ GEMINI_TTS_VOICE: "x" })).toBe("male");
  });
});

describe("ensureAudio", () => {
  it("synthesizes on a miss, stores the clip and records one row; the second call is a hit", async () => {
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    const first = await ensureAudio(keyed, env.DB, line);
    const key = await audioKey("ja", "male", line.text);
    expect(first).toEqual({ ok: true, key, made: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect([...new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer())]).toEqual([1, 2, 3]);
    const row = await env.DB.prepare("SELECT lang, voice, bytes FROM tts_audio WHERE key = ?").bind(key).first();
    expect(row).toEqual({ lang: "ja", voice: "male", bytes: 3 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tts_claims").first<{ n: number }>()).toEqual({ n: 0 });

    expect(await ensureAudio(keyed, env.DB, line)).toEqual({ ok: true, key, made: false });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await rowCount()).toBe(1);
    expect(await countSynthesizedToday(env.DB)).toBe(1);
  });

  it("answers limit without calling Google once today's syntheses reach the cap", async () => {
    await env.DB.prepare("INSERT INTO tts_audio (key, lang, voice, bytes, created_at) VALUES ('k', 'ja', 'male', 1, ?)").bind(new Date().toISOString()).run();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect(await ensureAudio({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "1" }, env.DB, line)).toEqual({ ok: false, reason: "limit" });
    expect(fn).not.toHaveBeenCalled();
    expect(await ensureAudio({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "2" }, env.DB, line)).toMatchObject({ ok: true, made: true });
  });

  it("does not count yesterday's syntheses, and treats a cap of 0 as paused", async () => {
    await env.DB.prepare("INSERT INTO tts_audio (key, lang, voice, bytes, created_at) VALUES ('k', 'ja', 'male', 1, ?)").bind(new Date(Date.now() - 48 * 3600_000).toISOString()).run();
    expect(await countSynthesizedToday(env.DB)).toBe(0);
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect(await ensureAudio({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "0" }, env.DB, line)).toEqual({ ok: false, reason: "limit" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("serves a stored clip even over the cap", async () => {
    const key = await audioKey("ja", "male", line.text);
    await env.BUCKET.put(key, new Uint8Array([9]));
    expect(await ensureAudio({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "0" }, env.DB, line)).toEqual({ ok: true, key, made: false });
  });

  it("answers unavailable without a key", async () => {
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect(await ensureAudio({ ...env, GOOGLE_TTS_SA_JSON: "" }, env.DB, line)).toEqual({ ok: false, reason: "unavailable" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("answers busy after the wait when another request holds the claim", async () => {
    const key = await audioKey("ja", "male", line.text);
    await env.DB.prepare("INSERT INTO tts_claims (key, created_at) VALUES (?, ?)").bind(key, Date.now()).run();
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect(await ensureAudio(keyed, env.DB, line, { waitMs: 300 })).toEqual({ ok: false, reason: "busy" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the winner's clip when it lands while waiting", async () => {
    const key = await audioKey("ja", "male", line.text);
    await env.DB.prepare("INSERT INTO tts_claims (key, created_at) VALUES (?, ?)").bind(key, Date.now()).run();
    setTimeout(() => void env.BUCKET.put(key, new Uint8Array([7])), 100);
    expect(await ensureAudio(keyed, env.DB, line, { waitMs: 2000 })).toEqual({ ok: true, key, made: false });
  });

  it("answers failed, releases the claim and records nothing when Google fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch([[GOOGLE, () => json({}, 500)]]);
    expect(await ensureAudio(keyed, env.DB, line)).toEqual({ ok: false, reason: "failed" });
    expect(await rowCount()).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tts_claims").first<{ n: number }>()).toEqual({ n: 0 });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(line.text);
    errorSpy.mockRestore();
  });

  it("counts a paid synthesis even when storing fails, and counts the later synthesis of the same key too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === "put") return async () => { throw new Error("r2 down"); };
        return (Reflect.get(target, prop) as (...a: unknown[]) => unknown).bind(target);
      },
    });
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    expect(await ensureAudio({ ...keyed, BUCKET: failing }, env.DB, line)).toEqual({ ok: false, reason: "failed" });
    expect(await rowCount()).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tts_claims").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await ensureAudio(keyed, env.DB, line)).toMatchObject({ ok: true, made: true });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await rowCount()).toBe(1);
    expect(await countSynthesizedToday(env.DB)).toBe(2);
  });

  it("stops at the cap when one key was synthesized twice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = new Proxy(env.BUCKET, {
      get(target, prop) {
        if (prop === "put") return async () => { throw new Error("r2 down"); };
        return (Reflect.get(target, prop) as (...a: unknown[]) => unknown).bind(target);
      },
    });
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    const capped = { ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "2" };
    expect(await ensureAudio({ ...capped, BUCKET: failing }, env.DB, line)).toEqual({ ok: false, reason: "failed" });
    expect(await ensureAudio({ ...capped, BUCKET: failing }, env.DB, line)).toEqual({ ok: false, reason: "failed" });
    expect(await ensureAudio(capped, env.DB, { ...line, text: "別の行です。" })).toEqual({ ok: false, reason: "limit" });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("answers failed for empty or whitespace text without touching the cap or Google", async () => {
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    for (const text of ["", "  \n\u3000"]) {
      expect(await ensureAudio({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "0" }, env.DB, { ...line, text })).toEqual({ ok: false, reason: "failed" });
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it("sends the English voice for lang en", async () => {
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: audio })]]);
    await ensureAudio(keyed, env.DB, { text: "Good evening", lang: "en", voice: "female" });
    const body = JSON.parse(String(fn.mock.calls[0]![1]?.body));
    expect(body.voice).toMatchObject({ languageCode: "en-US", name: "Kore" });
  });
});

describe("ensureAudio when the prompt was spoken", () => {
  it("counts the retries toward the cap", async () => {
    let n = 0;
    const long = btoa("x".repeat(25 * 4000));
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: ++n < 2 ? long : audio })]]);
    expect(await ensureAudio(keyed, env.DB, line)).toMatchObject({ ok: true, made: true });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await countSynthesizedToday(env.DB)).toBe(2);
  });
});

describe("ensureAudio when every attempt speaks the prompt", () => {
  it("fails, and the three paid calls still count toward the cap", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const long = btoa("x".repeat(25 * 4000));
    const { fn } = stubFetch([[GOOGLE, () => json({ audioContent: long })]]);
    expect(await ensureAudio(keyed, env.DB, line)).toEqual({ ok: false, reason: "failed" });
    expect(fn).toHaveBeenCalledTimes(3);
    expect(await countSynthesizedToday(env.DB)).toBe(3);
    // The cap now stops the next miss of another key.
    expect(await ensureAudio({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "3" }, env.DB, { ...line, text: "別の行です。" })).toEqual({ ok: false, reason: "limit" });
  });

});
