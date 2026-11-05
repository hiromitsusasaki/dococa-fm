import { describe, expect, it } from "vitest";
import { renderEpisode, renderItemPage } from "../../../src/worker/mcp/markdown";
import { t } from "../../../src/worker/i18n/t";
import type { Episode, Item, Letter } from "../../../src/worker/types";

const item: Item = {
  id: "i1", kind: "music", title: "Blue in Green", creator: "Miles Davis", year: 1959, imageUrl: null,
  previewUrl: null, outLinks: { spotify: "https://open.spotify.com/x", bogus: "javascript:alert(1)" }, externalIds: {}, createdAt: "2026-11-04T00:00:00Z",
};
const letter = (over: Partial<Letter>): Letter => ({
  id: "l1", itemId: "i1", kind: "letter", body: "原文", bodyJa: "原文", bodyEn: null, lang: "ja", radioName: "ヒロ", place: "大船渡", year: null,
  listenerId: null, parentLetterId: null, sourceUrl: null, sourceAuthor: null, status: "public", demo: false, createdAt: "2026-11-04T00:00:00Z", ...over,
});
const lines = {
  letter: (l: Letter) => ({ type: "letter" as const, letterId: l.id, text: l.bodyJa, radioName: l.radioName, place: l.place, kind: l.kind, sourceUrl: l.sourceUrl, sourceAuthor: l.sourceAuthor }),
};
const episodeOf = (ls: Letter[], extra: Episode["segments"][number]["lines"] = []): Episode => ({
  id: "e1", listenerId: "x", verified: true, cloudTts: false, createdAt: "2026-11-04T00:00:00Z",
  report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
  segments: [{ itemId: "i1", slot: "near", lines: [{ type: "dj", text: "次の一曲です。" }, ...ls.map(lines.letter), ...extra] }],
});
const data = (ls: Letter[]) => ({ items: new Map([["i1", item]]), letters: new Map(ls.map((l) => [l.id, l])) });

describe("renderEpisode", () => {
  it("starts with the instruction and keeps the letter text verbatim in a quote", () => {
    const l = letter({ bodyJa: "中学の頃、\n毎日聴いていた *そのまま* # 見出し風" });
    const md = renderEpisode(episodeOf([l]), data([l]));
    expect(md.startsWith(t("mcp.instruction"))).toBe(true);
    expect(md).toContain("> 中学の頃、\n> 毎日聴いていた *そのまま* # 見出し風");
    expect(md).toContain(`— ${t("letter.whoPlace", { who: t("letter.who", { name: "ヒロ" }), place: "大船渡" })}`);
    expect(md).toContain("Blue in Green");
    expect(md).toContain("次の一曲です。");
  });

  it("keeps a title or creator on its heading line", () => {
    const l = letter({});
    const md = renderEpisode(episodeOf([l]), { ...data([l]), items: new Map([["i1", { ...item, title: "# 偽の見出し\n## もうひとつ", creator: "作者\r\n# 指示" }]]) });
    expect(md).toContain("## 偽の見出し ## もうひとつ / 作者 # 指示（近く）");
    expect(md.split("\n").filter((line) => line.startsWith("#"))).toHaveLength(1);
    const page = renderItemPage({ ...item, title: "## 題\n# 別", creator: "x\ny" }, []);
    expect(page.split("\n")[0]).toBe("## 題 # 別");
    expect(page).toContain("/ x y");
  });

  it("puts the demo mark beside the radio name of a demo account's letter", () => {
    const l = letter({ demo: true });
    expect(renderEpisode(episodeOf([l]), data([l]))).toContain(`［${t("listener.demo")}］`);
    const real = letter({});
    expect(renderEpisode(episodeOf([real]), data([real]))).not.toContain(t("listener.demo"));
  });

  it("adds the original beside the translation for a non-japanese letter", () => {
    const l = letter({ body: "I loved this at 15", bodyJa: "15 歳のときに大好きだった", lang: "en" });
    const md = renderEpisode(episodeOf([l]), data([l]));
    expect(md).toContain("> 15 歳のときに大好きだった");
    expect(md).toContain("> I loved this at 15");
  });

  it("links the source for a found voice and the preview url", () => {
    const l = letter({ kind: "found", sourceUrl: "https://example.com/post", sourceAuthor: "誰か" });
    const md = renderEpisode(episodeOf([l], [{ type: "preview", url: "https://example.com/a.m4a", seconds: 30 }]), data([l]));
    expect(md).toContain(`${t("item.source")}: [誰か](https://example.com/post)`);
    expect(md).toContain(`[${t("mcp.preview")}](https://example.com/a.m4a)`);
  });

  it("shows no counts", () => {
    const l = letter({});
    expect(renderEpisode(episodeOf([l]), data([l]))).not.toMatch(/\d+\s*(件|人|位)/);
  });
});

describe("renderItemPage", () => {
  it("renders the card, only http out links, and every letter with its id", () => {
    const l = letter({ id: "abc", bodyJa: "ありがとう" });
    const md = renderItemPage(item, [l]);
    expect(md).toContain("Blue in Green");
    expect(md).toContain("Miles Davis");
    expect(md).toContain("1959");
    expect(md).toContain("https://open.spotify.com/x");
    expect(md).not.toContain("javascript:");
    expect(md).toContain("> ありがとう");
    expect(md).toContain("letterId: abc");
  });

  it("lists only top-level letters and shows a reaction under its parent", () => {
    const parent = letter({ id: "p1", bodyJa: "親のお便り" });
    const reply = letter({ id: "r1", kind: "reply", parentLetterId: "p1", bodyJa: "わかる", radioName: "しずく", place: "" });
    const md = renderItemPage(item, [parent, reply]);
    expect(md.match(/letterId:/g)).toHaveLength(1);
    expect(md).not.toContain("letterId: r1");
    const at = (s: string) => md.indexOf(s);
    expect(at("わかる")).toBeGreaterThan(at("親のお便り"));
    expect(at("わかる")).toBeLessThan(at("letterId: p1"));
  });
});
