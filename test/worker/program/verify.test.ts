import { describe, expect, it } from "vitest";
import { verifyEpisode } from "../../../src/worker/program/verify";
import type { ScriptLine, Segment } from "../../../src/worker/types";
import { byId, item, letter, listener } from "./fixtures";

const plain = letter({ id: "a" });
const translated = letter({ id: "e", body: "I listened alone at midnight.", bodyJa: "真夜中に一人で聴きました。", lang: "en" });
const found = letter({
  id: "f",
  kind: "found",
  body: "Reminds me of home.",
  bodyJa: "故郷を思い出す。",
  listenerId: null,
  radioName: "",
  place: "",
  sourceUrl: "https://www.youtube.com/watch?v=x",
  sourceAuthor: "@jazzcat",
});
const letters = byId([plain, translated, found]);
const me = listener();

const read = (l: typeof plain, text = l.bodyJa): ScriptLine => ({
  type: "letter",
  letterId: l.id,
  text,
  radioName: l.radioName,
  place: l.place,
  kind: l.kind,
  sourceUrl: l.sourceUrl,
  sourceAuthor: l.sourceAuthor,
});
const dj = (text: string): ScriptLine => ({ type: "dj", text });
const episode = (...lines: ScriptLine[]): Segment[] => [{ itemId: "i1", slot: "near", lines }];
const clean = () => episode(dj("静かな一曲から。"), read(plain), read(translated, translated.body), dj("ネットで見つけた声です。"), read(found), dj("次は遠くの一通へ。"));

describe("verifyEpisode", () => {
  it("passes a clean episode on all four points", () => {
    expect(verifyEpisode(clean(), letters, me)).toEqual({ verbatim: true, sources: true, topical: true, pii: true, details: [] });
  });

  it("verbatim is false when one character of a letter changes", () => {
    const r = verifyEpisode(episode(read(plain, plain.bodyJa.replace("少し", "すこし"))), letters, me);
    expect(r.verbatim).toBe(false);
    expect(r.details.length).toBeGreaterThan(0);
  });

  it("verbatim is false for trailing whitespace, an unknown letter or a changed attribution", () => {
    expect(verifyEpisode(episode(read(plain, `${plain.bodyJa} `)), letters, me).verbatim).toBe(false);
    expect(verifyEpisode(episode(read(letter({ id: "zz" }))), letters, me).verbatim).toBe(false);
    expect(verifyEpisode(episode({ ...(read(plain) as object), radioName: "別人" } as ScriptLine), letters, me).verbatim).toBe(false);
  });

  it("sources is false for a found voice without sourceUrl or sourceAuthor", () => {
    const noUrl = letter({ ...found, id: "g", sourceUrl: null });
    const noAuthor = letter({ ...found, id: "h", sourceAuthor: "" });
    const all = byId([plain, found, noUrl, noAuthor]);
    expect(verifyEpisode(episode(read(noUrl)), all, me).sources).toBe(false);
    expect(verifyEpisode(episode(read(noAuthor)), all, me).sources).toBe(false);
  });

  it("sources is false when a found voice is passed off as a plain letter", () => {
    const disguised = { ...(read(found) as object), kind: "letter", sourceUrl: null, sourceAuthor: null } as ScriptLine;
    expect(verifyEpisode(episode(disguised), letters, me).sources).toBe(false);
  });

  it.each(["2024年に出た曲です。", "２０２４年の話。", "今年いちばんの一曲。", "最近よく聴かれています。"])("topical is false for %s", (text) => {
    expect(verifyEpisode(episode(dj(text)), letters, me).topical).toBe(false);
  });

  it.each(["3人から届きました。", "３人から届きました。", "5通のお便りが来ています。", "二通目のお便りです。", "1位の曲です。", "ランキングの上の曲です。", "一致率の高い一曲。"])(
    "a count or ranking fails: %s",
    (text) => {
      const r = verifyEpisode(episode(dj(text)), letters, me);
      expect(r.topical).toBe(false);
      expect(r.details.some((d) => d.startsWith("measure:"))).toBe(true);
    },
  );

  it.each(["二人で聴きたい曲です。", "三人組のバンドです。", "百人一首のような短さ。", "世界のどこかの一通を。"])("a phrase that does not count passes: %s", (text) => {
    expect(verifyEpisode(episode(dj(text)), letters, me).topical).toBe(true);
  });

  it("topical is false for 今夜, and the detail names the word and the line", () => {
    const r = verifyEpisode(episode(dj("今夜はこの曲から。")), letters, me);
    expect(r.topical).toBe(false);
    expect(r.details[0]).toContain("「今夜」");
    expect(r.details[0]).toContain("今夜はこの曲から。");
  });

  describe("years from the data", () => {
    const items = byId([item({ id: "i1", year: 2016 })]);
    const withYear = letter({ id: "y", year: 2019, body: "高校のとき", bodyJa: "高校のとき" });

    it("lets the work's own year through", () => {
      expect(verifyEpisode(episode(dj("2016年の作品です。")), letters, me, items).topical).toBe(true);
      expect(verifyEpisode(episode(dj("２０１６年の作品です。")), letters, me, items).topical).toBe(true);
    });

    it("lets the year of a letter in the same segment through", () => {
      const r = verifyEpisode(episode(dj("2019年の思い出だそうです。"), read(withYear)), byId([withYear]), me, items);
      expect(r.topical).toBe(true);
    });

    it("still fails an unrelated year, or a letter's year used in another segment", () => {
      expect(verifyEpisode(episode(dj("2024年に出た曲です。")), letters, me, items).topical).toBe(false);
      const other: Segment[] = [
        { itemId: "i1", slot: "near", lines: [read(withYear)] },
        { itemId: "i2", slot: "far", lines: [dj("2019年の話です。")] },
      ];
      expect(verifyEpisode(other, byId([withYear]), me, items).topical).toBe(false);
    });
  });

  it("lets the work's own year and the program's phrases through", () => {
    expect(verifyEpisode(episode(dj("1959年の録音です。世界のどこかの一通を。")), letters, me).topical).toBe(true);
  });

  it.each([
    "連絡は hiro@example.com まで",
    "電話は 090-1234-5678 へ",
    "09012345678 にどうぞ",
    "詳しくは https://example.com で",
    "listener-0001 さんへ",
    "mcp-token-secret-0001",
  ])("pii is false for %s", (text) => {
    expect(verifyEpisode(episode(dj(text)), letters, me).pii).toBe(false);
  });

  it("pii is false when a dj line quotes a letter", () => {
    expect(verifyEpisode(episode(dj(`みなとさんは「${plain.bodyJa}」と書いています。`)), letters, me).pii).toBe(false);
    expect(verifyEpisode(episode(dj(`It says ${translated.body}`)), letters, me).pii).toBe(false);
  });

  describe("quoting a fragment", () => {
    const long = letter({
      id: "long",
      body: "父の車でカセットを何度も巻き戻して聴いた夏のことを、この曲を聴くたびに思い出します。あの頃の匂いまで。",
      bodyJa: "父の車でカセットを何度も巻き戻して聴いた夏のことを、この曲を聴くたびに思い出します。あの頃の匂いまで。",
    });
    const en = letter({ id: "en", body: "My grandmother hummed this while cooking every Sunday.", bodyJa: "祖母が毎週日曜に台所で口ずさんでいた。" });
    const all = byId([long, en]);

    it("pii is false when a dj line quotes a 12-character fragment of a long letter", () => {
      const r = verifyEpisode(episode(dj("「カセットを何度も巻き戻して」いたそうです。")), all, me);
      expect(r.pii).toBe(false);
      expect(r.details.some((d) => d.includes("quotes a letter") && !d.includes("カセット"))).toBe(true);
    });

    it("catches a fragment of the original language, across full-width letters and spacing", () => {
      expect(verifyEpisode(episode(dj("ｈｕｍｍｅｄ  this while cooking と。")), all, me).pii).toBe(false);
    });

    it("lets a paraphrase without a 10-character overlap through", () => {
      expect(verifyEpisode(episode(dj("車の中で何度も聴いた、家族の思い出の一曲です。")), all, me).pii).toBe(true);
    });

    it("lets the DJ name the work even when a letter names it too", () => {
      const items = byId([item({ id: "i1", title: "Blue in Green", creator: "Miles Davis" })]);
      const names = letter({ id: "n", body: "Blue in Green by Miles Davis saved me.", bodyJa: "Blue in Green に救われた。" });
      const r = verifyEpisode(episode(dj("Miles Davis の Blue in Green です。")), byId([names]), me, items);
      expect(r.details).toEqual([]);
    });
  });

  it("does not treat a short letter as a quote", () => {
    const short = letter({ id: "s", body: "私も", bodyJa: "私も" });
    expect(verifyEpisode(episode(dj("あおいさんから『私も』が届いています")), byId([short]), me).pii).toBe(true);
  });
});
