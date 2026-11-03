import { describe, expect, it } from "vitest";
import { t } from "../../src/worker/i18n/t";

describe("t", () => {
  it("returns the app name and tagline", () => {
    expect(t("app.name")).toBe("Dococa FM");
    expect(t("app.tagline")).toBe("世界のどこかの、好きなものが流れてくるラジオ");
  });
});
