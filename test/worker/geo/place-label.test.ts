import { describe, expect, it } from "vitest";
import { COUNTRIES, REGIONS } from "../../../src/worker/geo/places";
import { isValidRegion, placeLabel } from "../../../src/worker/geo/place-label";

describe("placeLabel", () => {
  it("names a Japanese prefecture without its suffix in Japanese", () => {
    expect(placeLabel("JP", "13", "ja")).toBe("東京");
    expect(placeLabel("JP", "27", "ja")).toBe("大阪");
    expect(placeLabel("JP", "26", "ja")).toBe("京都");
    expect(placeLabel("JP", "32", "ja")).toBe("島根");
    expect(placeLabel("JP", "01", "ja")).toBe("北海道");
  });

  it("names the prefecture and country in English", () => {
    expect(placeLabel("JP", "13", "en")).toBe("Tokyo, Japan");
  });

  it("names a US state and the country", () => {
    expect(placeLabel("US", "CA", "ja")).toBe("カリフォルニア州、アメリカ");
    expect(placeLabel("US", "CA", "en")).toBe("California, USA");
  });

  it("names just the country when there is no region", () => {
    expect(placeLabel("PT", null, "ja")).toBe("ポルトガル");
    expect(placeLabel("PT", null, "en")).toBe("Portugal");
    expect(placeLabel("JP", null, "ja")).toBe("日本");
  });

  it("falls back to the English name when there is no Japanese one", () => {
    expect(placeLabel("BV", null, "ja")).toBe("Bouvet Island");
  });

  it("is empty for no country or an unknown one", () => {
    expect(placeLabel(null, null, "ja")).toBe("");
    expect(placeLabel("ZZ", null, "en")).toBe("");
    expect(placeLabel("ZZ", "13", "en")).toBe("");
  });

  it("ignores a region that does not belong to the country", () => {
    expect(placeLabel("JP", "CA", "ja")).toBe("日本");
    expect(placeLabel("PT", "13", "en")).toBe("Portugal");
  });
});

describe("isValidRegion", () => {
  it("accepts no region for any known country", () => {
    expect(isValidRegion("PT", null)).toBe(true);
    expect(isValidRegion("JP", "")).toBe(true);
    expect(isValidRegion(null, null)).toBe(true);
  });

  it("accepts only regions listed for the country", () => {
    expect(isValidRegion("JP", "32")).toBe(true);
    expect(isValidRegion("JP", "48")).toBe(false);
    expect(isValidRegion("JP", "CA")).toBe(false);
    expect(isValidRegion("US", "CA")).toBe(true);
    expect(isValidRegion("US", "32")).toBe(false);
    expect(isValidRegion("PT", "01")).toBe(false);
    expect(isValidRegion(null, "13")).toBe(false);
  });
});

describe("place data", () => {
  it("has every ISO 3166-1 alpha-2 code once, Japan first, the rest sorted by English name", () => {
    expect(COUNTRIES).toHaveLength(249);
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(249);
    expect(COUNTRIES[0]!.code).toBe("JP");
    const rest = COUNTRIES.slice(1).map((c) => c.en);
    expect(rest).toEqual([...rest].sort(new Intl.Collator("en").compare));
  });

  it("names at least 60 countries in Japanese", () => {
    expect(COUNTRIES.filter((c) => c.ja !== c.en).length).toBeGreaterThanOrEqual(60);
  });

  it("lists 47 prefectures and 50 states plus DC", () => {
    expect(REGIONS.JP.map((r) => r.code)).toEqual(Array.from({ length: 47 }, (_, i) => String(i + 1).padStart(2, "0")));
    expect(REGIONS.US).toHaveLength(51);
    expect(REGIONS.US.find((r) => r.code === "DC")).toBeDefined();
  });
});
