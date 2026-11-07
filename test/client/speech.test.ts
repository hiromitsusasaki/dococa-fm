import { describe, expect, it } from "vitest";
import { pickVoice } from "../../src/client/speech";

const v = (voiceURI: string, name: string, lang = "ja-JP") => ({ voiceURI, name, lang }) as SpeechSynthesisVoice;

describe("pickVoice", () => {
  const voices = [v("kyoko", "Kyoko"), v("female", "Google Japanese Female"), v("otoya", "Otoya"), v("daniel", "Daniel", "en-GB")];

  it("keeps the voice the listener chose", () => {
    expect(pickVoice(voices, "kyoko")?.voiceURI).toBe("kyoko");
  });

  it("otherwise prefers a Japanese voice whose name suggests a male narrator", () => {
    expect(pickVoice(voices, "gone")?.voiceURI).toBe("otoya");
  });

  it("does not take Female for male, and falls back to the first Japanese voice", () => {
    expect(pickVoice([v("kyoko", "Kyoko"), v("female", "Google Japanese Female")], "")?.voiceURI).toBe("kyoko");
    expect(pickVoice([v("daniel", "Daniel", "en-GB")], "")).toBeUndefined();
  });
});
