import type { Env } from "../env";
import { accessToken, parseServiceAccount, type ServiceAccount } from "./google-auth";
import type { AudioLang, AudioVoice } from "./types";
import { DJ_STYLE_PROMPT, DJ_STYLE_PROMPT_EN } from "./style";

const ENDPOINT = "https://texttospeech.googleapis.com/v1/text:synthesize";
const DEFAULT_MODEL = "gemini-2.5-flash-tts";
const VOICE_NAME = { male: "Charon", female: "Kore" } as const;
/** The API takes at most 4,000 bytes of `input.text` (and of `input.prompt`). */
const MAX_TEXT_BYTES = 4000;
const TIMEOUT_MS = 20_000;

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Cuts `text` into pieces of at most `MAX_TEXT_BYTES`, preferring to end at 。 or 、. */
export function splitText(text: string): string[] {
  const chunks: string[] = [];
  let rest = [...text];
  while (utf8Length(rest.join("")) > MAX_TEXT_BYTES) {
    let bytes = 0;
    let fit = 0;
    for (const ch of rest) {
      bytes += utf8Length(ch);
      if (bytes > MAX_TEXT_BYTES) break;
      fit++;
    }
    const head = rest.slice(0, fit);
    const lastStop = Math.max(head.lastIndexOf("。"), head.lastIndexOf("、"));
    const cut = lastStop >= 0 ? lastStop + 1 : fit;
    chunks.push(head.slice(0, cut).join(""));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest.join(""));
  return chunks;
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The API's MP3 is 32 kbps CBR mono, so a clip's length follows from its bytes. */
const BYTES_PER_SECOND = 4000;
/** A clip may run this long per code point of its text, plus a fixed allowance for the pauses of a short line. */
const SECONDS_PER_CHAR = { ja: 0.27, en: 0.125 } as const;
const SLACK_SECONDS = 3;
/** Clips that spoke the prompt are made again up to this many paid calls per chunk. */
const ATTEMPTS = 3;

/**
 * Gemini-TTS now and then reads the style prompt aloud before the text. Such a clip is far longer than its text
 * can account for, which is the one mechanical sign of it. A spoken prompt adds about 8-21 s.
 *
 * The constants come from 170 ja and 194 en unit clips measured in production on 2026-11-07. ja: median 0.201
 * s/char, clean p90 about 0.23; 27 clips had +4...+21 s of excess. en: median 0.093, clean max about 0.115; 3
 * clips had +8...+10 s. The ja opening line (41 chars) took 16.6 s where about 8 s is normal. The earlier 0.5 / 0.35
 * s/char with 4 s of slack let every line over about 40 chars through, so the allowance is now just above the
 * slowest clean clip.
 */
export function spokeThePrompt(bytes: number, text: string, lang: AudioLang): boolean {
  return bytes / BYTES_PER_SECOND > SLACK_SECONDS + Array.from(text).length * SECONDS_PER_CHAR[lang];
}

/** A failure that carries the paid calls made before it, so the caller can count them toward the cap. */
export class SynthesisError extends Error {
  constructor(
    message: string,
    public readonly calls: number,
  ) {
    super(message);
    this.name = "SynthesisError";
  }
}

async function synthesizeChunk(env: Env, sa: ServiceAccount, text: string, voice: AudioVoice, lang: AudioLang): Promise<{ audio: Uint8Array; calls: number }> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let audio: Uint8Array;
    try {
      audio = await synthesizeOnce(env, sa, text, voice, lang);
    } catch (e) {
      // Only successful calls are billed: the earlier attempts of this chunk returned audio and count, this one does not.
      throw new SynthesisError(e instanceof Error ? e.message : "tts failed", attempt - 1);
    }
    if (!spokeThePrompt(audio.length, text, lang)) return { audio, calls: attempt };
  }
  throw new SynthesisError("tts prompt", ATTEMPTS);
}

async function synthesizeOnce(env: Env, sa: ServiceAccount, text: string, voice: AudioVoice, lang: AudioLang): Promise<Uint8Array> {
  const token = await accessToken(sa);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      input: { text, prompt: lang === "en" ? DJ_STYLE_PROMPT_EN : DJ_STYLE_PROMPT },
      voice: { languageCode: lang === "en" ? "en-US" : "ja-JP", name: VOICE_NAME[voice], modelName: env.GEMINI_TTS_MODEL || DEFAULT_MODEL },
      audioConfig: { audioEncoding: "MP3" },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // The status only: the body can carry the line.
  if (!res.ok) throw new Error(`tts ${res.status}`);
  const { audioContent } = (await res.json()) as { audioContent?: string };
  if (!audioContent) throw new Error("tts empty");
  return fromBase64(audioContent);
}

/**
 * Reads `text` aloud as MP3. Long text goes out in pieces and the MP3 frames are joined in order. `calls` is
 * the number of paid calls it took, retries included, for the daily cap. Throws `tts prompt` when a piece
 * spoke the prompt three times in a row.
 */
export async function synthesize(env: Env, text: string, voice: AudioVoice, lang: AudioLang): Promise<{ audio: ArrayBuffer; calls: number }> {
  const sa = parseServiceAccount(env.GOOGLE_TTS_SA_JSON);
  const parts: Uint8Array[] = [];
  let calls = 0;
  for (const chunk of splitText(text)) {
    try {
      const made = await synthesizeChunk(env, sa, chunk, voice, lang);
      parts.push(made.audio);
      calls += made.calls;
    } catch (e) {
      throw e instanceof SynthesisError ? new SynthesisError(e.message, calls + e.calls) : e;
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { audio: out.buffer, calls };
}
