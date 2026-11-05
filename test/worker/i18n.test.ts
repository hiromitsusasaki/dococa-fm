import { describe, expect, it } from "vitest";
import { t } from "../../src/worker/i18n/t";

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
