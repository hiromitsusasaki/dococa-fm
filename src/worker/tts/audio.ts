import { jstDayStartIso } from "../db/episodes";
import type { Env } from "../env";
import { limitFrom } from "../limits";
import { claimTts, releaseTts } from "./claim";
import { SynthesisError, synthesize } from "./google";
import type { AudioLang, AudioVoice } from "./types";

export type { AudioLang, AudioVoice } from "./types";

/** Lines synthesized per JST day when `CLOUD_TTS_GLOBAL_DAILY_LIMIT` is unset. */
export const DEFAULT_SYNTH_DAILY_LIMIT = 3000;
/** How long a request that lost the claim waits for the winner's clip to appear in R2. */
const WAIT_MS = 5_000;
const POLL_MS = 250;
/**
 * Paid calls after which a key with no clip is given up. A line that keeps speaking the prompt fails after three
 * calls per request; without this a listener coming back to it would pay three more each time. Six is two full
 * tries. The check is made before a request, so the bound is about six: five plus the calls of the request that
 * crosses it (up to three per chunk).
 */
export const MAX_SYNTH_PER_KEY = 6;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const voiceOf = (env: Pick<Env, "GEMINI_TTS_VOICE">): AudioVoice => (env.GEMINI_TTS_VOICE === "female" ? "female" : "male");

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same text in the same voice is the same clip for every listener. */
export async function audioKey(lang: AudioLang, voice: AudioVoice, text: string): Promise<string> {
  // v4: the guard was too loose for lines over ~40 chars and the English prompt changed (2026-11-07).
  return `tts/v4/${lang}/${voice}/${await sha256Hex(text)}.mp3`;
}

/**
 * Paid syntheses since the JST day began: the sum of `synth_count` over today's rows. A key made again today
 * carries its earlier syntheses into today, so the count errs on the high side.
 */
export async function countSynthesizedToday(db: D1Database, now: Date = new Date()): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(synth_count), 0) AS n FROM tts_audio WHERE created_at >= ?")
    .bind(jstDayStartIso(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Adds `calls` paid syntheses of `key` to today's count; a row with no clip in R2 is fine (R2 is what is checked for a hit). */
async function countSynthesis(db: D1Database, key: string, line: { lang: AudioLang; voice: AudioVoice }, bytes: number, calls: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tts_audio (key, lang, voice, bytes, synth_count, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET synth_count = synth_count + excluded.synth_count, bytes = excluded.bytes, created_at = excluded.created_at`,
    )
    .bind(key, line.lang, line.voice, bytes, calls, new Date().toISOString())
    .run();
}

async function synthCountOf(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare("SELECT synth_count FROM tts_audio WHERE key = ?").bind(key).first<{ synth_count: number }>();
  return row?.synth_count ?? 0;
}

/** `gaveUp`: the key has used `MAX_SYNTH_PER_KEY` paid calls without a clip; it is not tried again. */
export type Ensured = { ok: true; key: string; made: boolean } | { ok: false; reason: "limit" | "busy" | "failed" | "unavailable" | "gaveUp" };

/**
 * R2 hit → ok (made false). Miss → cap check → claimTts(key) → synthesize → upsert tts_audio → BUCKET.put → release.
 * The cap (`CLOUD_TTS_GLOBAL_DAILY_LIMIT`, lines per JST day) is counted before the paid call and counts every
 * synthesis: the row is written before the put, so a failed put still uses up the cap, and a key synthesized
 * again adds one to its `synth_count`. A lost claim waits up to 5 s for the winner's clip (busy after that); the
 * claim keeps two requests for the same key to one call. Misses of distinct keys at once can each pass the
 * last remaining slot (bounded by the `/tts` limiters and the single prepare batch).
 * A key whose `synth_count` has reached `MAX_SYNTH_PER_KEY` with no clip in R2 is given up (`gaveUp`, no call):
 * a line that keeps speaking the prompt costs about six paid calls in all (five plus the calls of the request
 * that crosses the line, up to three per chunk). Deleting its `tts_audio` row lets it be tried again.
 */
export async function ensureAudio(
  env: Env,
  db: D1Database,
  line: { text: string; lang: AudioLang; voice: AudioVoice },
  opts: { waitMs?: number } = {},
): Promise<Ensured> {
  if (line.text.trim() === "") return { ok: false, reason: "failed" };
  const key = await audioKey(line.lang, line.voice, line.text);
  if (await env.BUCKET.head(key)) return { ok: true, key, made: false };

  if (!env.GOOGLE_TTS_SA_JSON) return { ok: false, reason: "unavailable" };
  if ((await countSynthesizedToday(db)) >= limitFrom(env.CLOUD_TTS_GLOBAL_DAILY_LIMIT, DEFAULT_SYNTH_DAILY_LIMIT)) return { ok: false, reason: "limit" };

  if (!(await claimTts(db, key))) {
    for (let waited = 0; waited < (opts.waitMs ?? WAIT_MS); waited += POLL_MS) {
      await sleep(POLL_MS);
      if (await env.BUCKET.head(key)) return { ok: true, key, made: false };
    }
    return { ok: false, reason: "busy" };
  }
  try {
    // The winner of an earlier claim may have stored the clip and released between our R2 miss and this claim.
    if (await env.BUCKET.head(key)) return { ok: true, key, made: false };
    if ((await synthCountOf(db, key)) >= MAX_SYNTH_PER_KEY) {
      console.error("[dococa] tts gave up");
      return { ok: false, reason: "gaveUp" };
    }
    let made: { audio: ArrayBuffer; calls: number };
    try {
      made = await synthesize(env, line.text, line.voice, line.lang);
    } catch (e) {
      // Paid calls that ended in a failure (the prompt spoken three times, an API error) still use up the cap.
      if (e instanceof SynthesisError && e.calls > 0) await countSynthesis(db, key, line, 0, e.calls);
      throw e;
    }
    // Counted as soon as the paid calls return (retries included), so a failed put still uses up the cap.
    await countSynthesis(db, key, line, made.audio.byteLength, made.calls);
    await env.BUCKET.put(key, made.audio, { httpMetadata: { contentType: "audio/mpeg" } });
    return { ok: true, key, made: true };
  } catch (e) {
    // Name and our own fixed messages only: a fetch TypeError can quote the request URL, and the body can carry the line.
    const status = e instanceof Error && /^tts (\d+|empty|prompt|token \d+|token empty|sa json invalid)$/.test(e.message) ? ` ${e.message}` : "";
    console.error(`[dococa] tts failed: ${e instanceof Error ? e.name : "unknown"}${status}`);
    return { ok: false, reason: "failed" };
  } finally {
    await releaseTts(db, key);
  }
}
