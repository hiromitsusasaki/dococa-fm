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

async function synthesizeChunk(env: Env, sa: ServiceAccount, text: string, voice: AudioVoice, lang: AudioLang): Promise<Uint8Array> {
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

/** Reads `text` aloud as MP3. Long text goes out in pieces and the MP3 frames are joined in order. */
export async function synthesize(env: Env, text: string, voice: AudioVoice, lang: AudioLang): Promise<ArrayBuffer> {
  const sa = parseServiceAccount(env.GOOGLE_TTS_SA_JSON);
  const parts: Uint8Array[] = [];
  for (const chunk of splitText(text)) parts.push(await synthesizeChunk(env, sa, chunk, voice, lang));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}
