import { jstDayStartIso } from "../db/episodes";
import type { Env } from "../env";
import { limitFrom } from "../limits";
import { claimTts, releaseTts } from "./claim";
import { synthesize } from "./google";
import type { AudioLang, AudioVoice } from "./types";

export type { AudioLang, AudioVoice } from "./types";

/** Lines synthesized per JST day when `CLOUD_TTS_GLOBAL_DAILY_LIMIT` is unset. */
export const DEFAULT_SYNTH_DAILY_LIMIT = 3000;
/** How long a request that lost the claim waits for the winner's clip to appear in R2. */
const WAIT_MS = 5_000;
const POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const voiceOf = (env: Pick<Env, "GEMINI_TTS_VOICE">): AudioVoice => (env.GEMINI_TTS_VOICE === "female" ? "female" : "male");

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same text in the same voice is the same clip for every listener. */
export async function audioKey(lang: AudioLang, voice: AudioVoice, text: string): Promise<string> {
  // v3: every v2 clip was made before the prompt-reading guard and may carry the voice direction.
  return `tts/v3/${lang}/${voice}/${await sha256Hex(text)}.mp3`;
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

export type Ensured = { ok: true; key: string; made: boolean } | { ok: false; reason: "limit" | "busy" | "failed" | "unavailable" };

/**
 * R2 hit → ok (made false). Miss → cap check → claimTts(key) → synthesize → upsert tts_audio → BUCKET.put → release.
 * The cap (`CLOUD_TTS_GLOBAL_DAILY_LIMIT`, lines per JST day) is counted before the paid call and counts every
 * synthesis: the row is written before the put, so a failed put still uses up the cap, and a key synthesized
 * again adds one to its `synth_count`. A lost claim waits up to 5 s for the winner's clip (busy after that); the
 * claim keeps two requests for the same key to one call. Misses of distinct keys at once can each pass the
 * last remaining slot (bounded by the `/tts` limiters and the single prepare batch).
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
    const { audio, calls } = await synthesize(env, line.text, line.voice, line.lang);
    // Counted as soon as the paid calls return (retries included), so a failed put still uses up the cap.
    await db
      .prepare(
        `INSERT INTO tts_audio (key, lang, voice, bytes, synth_count, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET synth_count = synth_count + excluded.synth_count, bytes = excluded.bytes, created_at = excluded.created_at`,
      )
      .bind(key, line.lang, line.voice, audio.byteLength, calls, new Date().toISOString())
      .run();
    await env.BUCKET.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" } });
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
