import { describe, expect, it } from "vitest";
import { en } from "../../src/worker/i18n/en";
import { ja } from "../../src/worker/i18n/ja";
import { langFromAcceptLanguage, t, tFor } from "../../src/worker/i18n/t";

describe("t", () => {
  it("replaces {name} placeholders", () => {
    expect(t("letter.who", { name: "ヒロ" })).toBe("ヒロさん");
  });

  it("returns the app name and tagline", () => {
    expect(t("app.name")).toBe("Dococa FM");
    expect(t("app.tagline")).toBe("世界のどこかにいる誰かの好きなものが聴こえてくるラジオ");
  });

  it("has the station vocabulary", () => {
    expect(t("station.on")).toBe("ラジオをつける");
    expect(t("station.dial")).toBe("セレンディピティ");
  });
});

describe("english", () => {
  it("has exactly the keys of the japanese table", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  it("uses the same placeholders as the japanese text for every key", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(ja) as (keyof typeof ja)[]) expect(holes(en[key]), key).toEqual(holes(ja[key]));
  });

  it("reads the vocabulary of the design doc", () => {
    expect(t("station.on", undefined, "en")).toBe("Turn the radio on");
    expect(t("station.dial", undefined, "en")).toBe("Serendipity");
    expect(t("station.nowPlaying", undefined, "en")).toBe("Now playing");
    expect(t("letter.showOriginal", undefined, "en")).toBe("Show original");
    expect(t("station.public", { name: "Hiro" }, "en")).toBe("Hiro's radio");
  });

  it("tFor fixes the language", () => {
    expect(tFor("en")("put.title")).toBe("Send a letter");
    expect(tFor("ja")("put.title")).toBe(ja["put.title"]);
  });
});

describe("langFromAcceptLanguage", () => {
  it("is english only when english is the first tag", () => {
    expect(langFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(langFromAcceptLanguage("en")).toBe("en");
    expect(langFromAcceptLanguage("EN-gb")).toBe("en");
    expect(langFromAcceptLanguage("ja,en;q=0.8")).toBe("ja");
    expect(langFromAcceptLanguage("fr-FR,en;q=0.8")).toBe("ja");
    expect(langFromAcceptLanguage("enx")).toBe("ja");
    expect(langFromAcceptLanguage("")).toBe("ja");
    expect(langFromAcceptLanguage(undefined)).toBe("ja");
  });
});
