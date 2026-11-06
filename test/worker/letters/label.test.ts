import { describe, expect, it } from "vitest";
import { siteLabel, whoLine } from "../../../src/worker/letters/label";
import { ja } from "../../../src/worker/i18n/ja";

const say = (key: keyof typeof ja, params: Record<string, string> = {}) => ja[key].replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m);

describe("whoLine", () => {
  it.each([
    [{ radioName: "しずく", place: "松本" }, "しずくさん（松本）"],
    [{ radioName: "しずく", place: "" }, "しずくさん"],
    [{ radioName: "", place: "" }, "名無しのリスナー"],
  ])("%j is %s", (l, expected) => {
    expect(whoLine(l, say)).toBe(expected);
  });

  it("makes the place from the codes in the reader's language, else the stored label", () => {
    const l = { radioName: "しずく", place: "島根", placeCountry: "JP", placeRegion: "32" };
    expect(whoLine(l, say, "en")).toBe("しずくさん（Shimane, Japan）");
    expect(whoLine(l, say, "ja")).toBe("しずくさん（島根）");
    expect(whoLine({ ...l, placeCountry: null, placeRegion: null }, say, "en")).toBe("しずくさん（島根）");
    expect(whoLine({ ...l, placeCountry: "ZZ" }, say, "en")).toBe("しずくさん（島根）");
  });

  it("marks a demo account at the end", () => {
    expect(whoLine({ radioName: "しずく", place: "松本", demo: true }, say)).toContain(ja["listener.demo"]);
  });
});

describe("siteLabel", () => {
  it.each([
    ["https://www.youtube.com/watch?v=x", "YouTube"],
    ["https://youtu.be/x", "YouTube"],
    ["https://www.reddit.com/r/jazz", "reddit.com"],
    ["not a url", ""],
    [null, ""],
  ])("%s is %j", (url, site) => {
    expect(siteLabel(url)).toBe(site);
  });
});
