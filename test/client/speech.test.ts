import { describe, expect, it } from "vitest";
import { pickVoice } from "../../src/client/speech";

const v = (voiceURI: string, name: string, lang = "ja-JP") => ({ voiceURI, name, lang }) as SpeechSynthesisVoice;

describe("pickVoice", () => {
  const voices = [v("samantha", "Samantha", "en-US"), v("kyoko", "Kyoko"), v("female", "Google Japanese Female"), v("otoya", "Otoya"), v("daniel", "Daniel", "en-GB")];

  it("keeps the voice the listener chose when it speaks the language", () => {
    expect(pickVoice(voices, "kyoko", "ja")?.voiceURI).toBe("kyoko");
  });

  it("otherwise prefers a voice of the language whose name suggests a male narrator", () => {
    expect(pickVoice(voices, "gone", "ja")?.voiceURI).toBe("otoya");
    expect(pickVoice(voices, "gone", "en")?.voiceURI).toBe("daniel");
  });

  it("English never takes a Japanese voice, even the one the listener chose", () => {
    expect(pickVoice(voices, "kyoko", "en")?.voiceURI).toBe("daniel");
    expect(pickVoice([v("kyoko", "Kyoko"), v("samantha", "Samantha", "en-US")], "kyoko", "en")?.voiceURI).toBe("samantha");
  });

  it("does not take Female for male, falls back to the first of the language, then to any voice", () => {
    expect(pickVoice([v("kyoko", "Kyoko"), v("female", "Google Japanese Female")], "", "ja")?.voiceURI).toBe("kyoko");
    expect(pickVoice([v("daniel", "Daniel", "en-GB")], "", "ja")?.voiceURI).toBe("daniel");
    expect(pickVoice([], "", "ja")).toBeUndefined();
  });
});
