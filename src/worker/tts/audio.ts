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
  return `tts/v2/${lang}/${voice}/${await sha256Hex(text)}.mp3`;
}

/** Clips synthesized since the JST day began. */
export async function countSynthesizedToday(db: D1Database, now: Date = new Date()): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM tts_audio WHERE created_at >= ?").bind(jstDayStartIso(now)).first<{ n: number }>();
  return row?.n ?? 0;
}

export type Ensured = { ok: true; key: string; made: boolean } | { ok: false; reason: "limit" | "busy" | "failed" | "unavailable" };

/**
 * R2 hit → ok (made false). Miss → cap check → claimTts(key) → synthesize → INSERT tts_audio → BUCKET.put → release.
 * The row is inserted before the put, so the cap counts a clip even when the put fails. A lost claim waits up to 5 s for the winner's clip (busy after that). The cap is counted before the paid call;
 * the claim keeps two requests for the same key to one call.
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
    const audio = await synthesize(env, line.text, line.voice, line.lang);
    // Counted as soon as the paid call returns, so a failed put still uses up the cap.
    await db
      .prepare("INSERT OR REPLACE INTO tts_audio (key, lang, voice, bytes, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(key, line.lang, line.voice, audio.byteLength, new Date().toISOString())
      .run();
    await env.BUCKET.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" } });
    return { ok: true, key, made: true };
  } catch (e) {
    // Name and our own fixed messages only: a fetch TypeError can quote the request URL, and the body can carry the line.
    const status = e instanceof Error && /^tts (\d+|empty|token \d+|token empty|sa json invalid)$/.test(e.message) ? ` ${e.message}` : "";
    console.error(`[dococa] tts failed: ${e instanceof Error ? e.name : "unknown"}${status}`);
    return { ok: false, reason: "failed" };
  } finally {
    await releaseTts(db, key);
  }
}
