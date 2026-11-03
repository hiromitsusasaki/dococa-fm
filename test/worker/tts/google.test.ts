import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../../src/worker/env";
import { DJ_STYLE_PROMPT } from "../../../src/worker/tts/style";
import { synthesize } from "../../../src/worker/tts/google";
import { json, stubFetch } from "../../helpers/fetch";

const URL_PREFIX = "https://texttospeech.googleapis.com/v1/text:synthesize";
const env = { GOOGLE_TTS_API_KEY: "k-test" } as Env;
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const bytesOf = (buf: ArrayBuffer) => [...new Uint8Array(buf)];

afterEach(() => vi.unstubAllGlobals());

describe("synthesize", () => {
  it("posts the style prompt, model and voice, and decodes audioContent", async () => {
    const { fn } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([1, 2, 3]) })]]);
    const out = await synthesize(env, "こんばんは。", "male");
    expect(bytesOf(out)).toEqual([1, 2, 3]);
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe(`${URL_PREFIX}?key=k-test`);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      input: { text: "こんばんは。", prompt: DJ_STYLE_PROMPT },
      voice: { languageCode: "ja-JP", name: "Charon", modelName: "gemini-2.5-flash-tts" },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("encodes the key in the URL", async () => {
    const { fn } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([1]) })]]);
    await synthesize({ ...env, GOOGLE_TTS_API_KEY: "a&b=c" }, "あ", "male");
    expect(String(fn.mock.calls[0]![0])).toBe(`${URL_PREFIX}?key=a%26b%3Dc`);
  });

  it("uses Kore for female and GEMINI_TTS_MODEL when set", async () => {
    const { fn } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([9]) })]]);
    await synthesize({ ...env, GEMINI_TTS_MODEL: "gemini-x" }, "あ", "female");
    const body = JSON.parse(String(fn.mock.calls[0]![1]?.body));
    expect(body.voice).toMatchObject({ name: "Kore", modelName: "gemini-x" });
  });

  it("splits text over 4,000 bytes at a 。 and joins the audio in order", async () => {
    let n = 0;
    const { fn } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([++n]) })]]);
    const first = `${"あ".repeat(1000)}。`; // 3,003 bytes
    const second = "い".repeat(500); // 1,500 bytes
    const out = await synthesize(env, first + second, "male");
    expect(fn).toHaveBeenCalledTimes(2);
    const texts = fn.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).input.text);
    expect(texts).toEqual([first, second]);
    expect(bytesOf(out)).toEqual([1, 2]);
  });

  it("hard-splits by code points when there is no 。 or 、", async () => {
    const { fn } = stubFetch([[URL_PREFIX, () => json({ audioContent: b64([0]) })]]);
    const text = "𠮷".repeat(1100); // 4 bytes each, 4,400 bytes
    await synthesize(env, text, "male");
    const texts = fn.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).input.text as string);
    expect(texts).toHaveLength(2);
    expect(texts.join("")).toBe(text);
    for (const t of texts) expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(4000);
  });

  it("throws on a non-2xx response without echoing the body", async () => {
    stubFetch([[URL_PREFIX, () => json({ error: { message: "secret detail" } }, 403)]]);
    await expect(synthesize(env, "あ", "male")).rejects.toThrow("tts 403");
  });
});
