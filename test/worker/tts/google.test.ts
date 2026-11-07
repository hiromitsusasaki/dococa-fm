import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/worker/env";
import { DJ_STYLE_PROMPT, DJ_STYLE_PROMPT_EN } from "../../../src/worker/tts/style";
import { spokeThePrompt, synthesize } from "../../../src/worker/tts/google";
import { resetTokenCache } from "../../../src/worker/tts/google-auth";
import { json, stubFetch as stubRoutes } from "../../helpers/fetch";
import { makeServiceAccount } from "../../helpers/service-account";

const URL_PREFIX = "https://texttospeech.googleapis.com/v1/text:synthesize";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const { json: saJson } = await makeServiceAccount();
const env = { GOOGLE_TTS_SA_JSON: saJson } as Env;
/** Stubs the TTS endpoint and the token endpoint; `fn` sees both, `ttsCalls()` only the TTS requests. */
function stubFetch(routes: Parameters<typeof stubRoutes>[0]) {
  const { fn } = stubRoutes([[TOKEN_URL, () => json({ access_token: "tok-test", expires_in: 3600 })], ...routes]);
  const ttsCalls = () => fn.mock.calls.filter(([u]) => String(u).startsWith(URL_PREFIX));
  return { fn, ttsCalls };
}
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const bytesOf = (buf: ArrayBuffer) => [...new Uint8Array(buf)];

beforeEach(() => resetTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe("synthesize", () => {
  it("posts the style prompt, model and voice, and decodes audioContent", async () => {
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([1, 2, 3]) })]]);
    const out = await synthesize(env, "こんばんは。", "male", "ja");
    expect(bytesOf(out.audio)).toEqual([1, 2, 3]);
    const [url, init] = ttsCalls()[0]!;
    expect(String(url)).toBe(URL_PREFIX);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok-test" });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      input: { text: "こんばんは。", prompt: DJ_STYLE_PROMPT },
      voice: { languageCode: "ja-JP", name: "Charon", modelName: "gemini-2.5-flash-tts" },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("sends en-US and the English style prompt for lang en", async () => {
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([1]) })]]);
    await synthesize(env, "Good evening.", "female", "en");
    const body = JSON.parse(String(ttsCalls()[0]![1]?.body));
    expect(body.input).toEqual({ text: "Good evening.", prompt: DJ_STYLE_PROMPT_EN });
    expect(body.voice).toMatchObject({ languageCode: "en-US", name: "Kore" });
  });

  it("sends no key in the URL", async () => {
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([1]) })]]);
    await synthesize(env, "あ", "male", "ja");
    expect(String(ttsCalls()[0]![0])).not.toContain("key=");
  });

  it("asks for a token once across calls", async () => {
    const { fn } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([1]) })]]);
    await synthesize(env, "あ", "male", "ja");
    await synthesize(env, "い", "male", "ja");
    expect(fn.mock.calls.filter(([u]) => String(u) === TOKEN_URL)).toHaveLength(1);
  });

  it("rejects an invalid service-account json before any request", async () => {
    const { fn } = stubFetch([]);
    await expect(synthesize({ GOOGLE_TTS_SA_JSON: "{}" } as Env, "あ", "male", "ja")).rejects.toThrow("tts sa json invalid");
    expect(fn).not.toHaveBeenCalled();
  });

  it("uses Kore for female and GEMINI_TTS_MODEL when set", async () => {
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([9]) })]]);
    await synthesize({ ...env, GEMINI_TTS_MODEL: "gemini-x" }, "あ", "female", "ja");
    const body = JSON.parse(String(ttsCalls()[0]![1]?.body));
    expect(body.voice).toMatchObject({ name: "Kore", modelName: "gemini-x" });
  });

  it("splits text over 4,000 bytes at a 。 and joins the audio in order", async () => {
    let n = 0;
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([++n]) })]]);
    const first = `${"あ".repeat(1000)}。`; // 3,003 bytes
    const second = "い".repeat(500); // 1,500 bytes
    const out = await synthesize(env, first + second, "male", "ja");
    expect(ttsCalls()).toHaveLength(2);
    const texts = ttsCalls().map((c) => JSON.parse(String(c[1]?.body)).input.text);
    expect(texts).toEqual([first, second]);
    expect(bytesOf(out.audio)).toEqual([1, 2]);
  });

  it("hard-splits by code points when there is no 。 or 、", async () => {
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([0]) })]]);
    const text = "𠮷".repeat(1100); // 4 bytes each, 4,400 bytes
    await synthesize(env, text, "male", "ja");
    const texts = ttsCalls().map((c) => JSON.parse(String(c[1]?.body)).input.text as string);
    expect(texts).toHaveLength(2);
    expect(texts.join("")).toBe(text);
    for (const t of texts) expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(4000);
  });

  it("throws on a non-2xx response without echoing the body", async () => {
    stubFetch([[URL_PREFIX, () => json({ error: { message: "secret detail" } }, 403)]]);
    await expect(synthesize(env, "あ", "male", "ja")).rejects.toThrow("tts 403");
  });
});

describe("spokeThePrompt", () => {
  // 32 kbps: 4,000 bytes per second.
  it("flags a clip that spoke the prompt", () => {
    // Measured in production 2026-11-07
    expect(spokeThePrompt(16.6 * 4000, "Dococa FM。世界のどこかにいる誰かの好きなものへのお便りを、お届けします。", "ja")).toBe(true); // 41 ch
    expect(spokeThePrompt(33.6 * 4000, "あ".repeat(64), "ja")).toBe(true);
    expect(spokeThePrompt(25 * 4000, "ここで一息。", "ja")).toBe(true);
    expect(spokeThePrompt(21.1 * 4000, "a".repeat(117), "en")).toBe(true);
    expect(spokeThePrompt(22 * 4000, "The next letter.", "en")).toBe(true);
  });
  it("accepts honest clips, including the slowest clean ones measured", () => {
    expect(spokeThePrompt(17.9 * 4000, "あ".repeat(68), "ja")).toBe(false);
    expect(spokeThePrompt(24.4 * 4000, "あ".repeat(120), "ja")).toBe(false);
    expect(spokeThePrompt(3 * 4000, "ここで一息。", "ja")).toBe(false);
    expect(spokeThePrompt(13.8 * 4000, "a".repeat(94), "en")).toBe(false);
    expect(spokeThePrompt(16.6 * 4000, "a".repeat(148), "en")).toBe(false);
    expect(spokeThePrompt(2.5 * 4000, "The next letter.", "en")).toBe(false);
  });
  it("prices each character by its script, not by the programme language", () => {
    // A Japanese found voice read in an English programme
    expect(spokeThePrompt(20 * 4000, "あ".repeat(80), "en")).toBe(false);
    // A Japanese line with a Latin song title
    expect(spokeThePrompt(6 * 4000, "エド・シーランの「Shape of You」です。", "ja")).toBe(false);
    expect(spokeThePrompt(6 * 4000, "エド・シーランの「Shape of You」です。", "en")).toBe(false);
  });
});

describe("synthesize when the prompt is spoken", () => {
  const longClip = () => json({ audioContent: btoa("x".repeat(25 * 4000)) });
  it("makes the chunk again and counts every call", async () => {
    let n = 0;
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => (++n < 3 ? longClip() : json({ audioContent: b64([7]) }))]]);
    const out = await synthesize(env, "ここで一息。", "male", "ja");
    expect(bytesOf(out.audio)).toEqual([7]);
    expect(out.calls).toBe(3);
    expect(ttsCalls()).toHaveLength(3);
  });
  it("gives up after three spoken prompts with a fixed message", async () => {
    const { ttsCalls } = stubFetch([[URL_PREFIX, longClip]]);
    await expect(synthesize(env, "ここで一息。", "male", "ja")).rejects.toThrow("tts prompt");
    expect(ttsCalls()).toHaveLength(3);
  });
  it("counts one call for a clip of the expected length", async () => {
    const { ttsCalls } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([1]) })]]);
    expect((await synthesize(env, "ここで一息。", "male", "ja")).calls).toBe(1);
    expect(ttsCalls()).toHaveLength(1);
  });
});
