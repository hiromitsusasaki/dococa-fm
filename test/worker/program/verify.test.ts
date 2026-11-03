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
  ...(l.demo ? { demo: true as const } : {}),
});
const dj = (text: string): ScriptLine => ({ type: "dj", text });
const fixedDj = (text: string): ScriptLine => ({ type: "dj", text, fixed: true });
const episode = (...lines: ScriptLine[]): Segment[] => [{ itemId: "i1", slot: "near", lines }];
const clean = () => episode(dj("静かな一曲から。"), read(plain), read(translated, translated.body), fixedDj("ネットで見つけた声です。@jazzcatさん、YouTubeのコメントから。"), read(found), dj("次は遠くの一通へ。"));

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

  it("verbatim is false when the demo mark of a demo account's letter is dropped", () => {
    const demo = letter({ id: "d", demo: true });
    const all = byId([demo]);
    expect(verifyEpisode(episode(read(demo)), all, me).verbatim).toBe(true);
    expect(verifyEpisode(episode({ ...(read(demo) as object), demo: undefined } as ScriptLine), all, me).verbatim).toBe(false);
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

  it.each([
    "3人から届きました。",
    "３人から届きました。",
    "3名の方から届きました。",
    "5通のお便りが来ています。",
    "1位の曲です。",
    "何通も届いています。",
    "何人もの方が。",
    "五人の方から届きました。",
    "十人から届きました。",
    "一通届きました。",
    "二通目のお便りです。",
    "1万回再生の曲。",
    "第一位の曲です。",
    "ランキングの上の曲です。",
    "一致率の高い一曲。",
  ])(
    "a count or ranking fails: %s",
    (text) => {
      const r = verifyEpisode(episode(dj(text)), letters, me);
      expect(r.topical).toBe(false);
      expect(r.details.some((d) => d.startsWith("measure:"))).toBe(true);
    },
  );

  it.each(["二人で聴きたい曲です。", "三人組のバンドです。", "百人一首のような短さ。", "二人の時間に。", "世界のどこかの一通を。", "3回聴いた曲です。", "2回目のサビで。"])(
    "a phrase that does not count passes: %s",
    (text) => {
    expect(verifyEpisode(episode(dj(text)), letters, me).topical).toBe(true);
  });

  it("topical is false for 今夜, and the detail names the check, the place and the word, not the line", () => {
    const r = verifyEpisode(episode(dj("今夜はこの曲から。")), letters, me);
    expect(r.topical).toBe(false);
    expect(r.details).toEqual(["topical: segment 1 line 1: 今夜"]);
    expect(r.details[0]).not.toContain("今夜はこの曲から。");
  });

  it("gives fixed template lines only the account and quote checks", () => {
    expect(verifyEpisode(episode(fixedDj("3人家族さん（那覇）から『私も』が届いています")), letters, me)).toMatchObject({ topical: true, pii: true });
    expect(verifyEpisode(episode(dj("3人家族さん（那覇）から『私も』が届いています")), letters, me).topical).toBe(false);
    expect(verifyEpisode(episode(fixedDj("ネットで見つけた声です。a@b.coさん、note.comのコメントから。")), letters, me).pii).toBe(true);
    expect(verifyEpisode(episode(fixedDj("listener-0001さんから『私も』が届いています")), letters, me).pii).toBe(false);
    expect(verifyEpisode(episode(fixedDj(`みなとさん（${plain.bodyJa}）から『私も』が届いています`)), letters, me).pii).toBe(false);
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
    const items = byId([item({ id: "i1", year: 1959 })]);
    expect(verifyEpisode(episode(dj("1959年の録音です。世界のどこかの一通を。")), letters, me, items).topical).toBe(true);
  });

  it.each(["1999年の夏を思い出す曲。", "令和3年に出た曲です。", "平成元年の録音。"])("topical is false for a year not in the data: %s", (text) => {
    const items = byId([item({ id: "i1", year: 2016 })]);
    expect(verifyEpisode(episode(dj(text)), letters, me, items).topical).toBe(false);
  });

  it("still catches 年末 right after the work's own year", () => {
    const items = byId([item({ id: "i1", year: 2016 })]);
    const r = verifyEpisode(episode(dj("2016年末に出た一枚です。")), letters, me, items);
    expect(r.topical).toBe(false);
    expect(r.details).toEqual(["topical: segment 1 line 1: 年末"]);
  });

  it.each([
    "連絡は hiro@example.com まで",
    "電話は 090-1234-5678 へ",
    "09012345678 にどうぞ",
    "詳しくは https://example.com で",
    "listener-0001 さんへ",
    "mcp-token-secret-0001",
    "電話は +81 90 1234 5678 へ",
    "www.example.org を見て",
    "example.com で検索",
    "dococa.fm にどうぞ",
    "hiro\u200b@example.com まで",
    "listener-\u200b0001 さんへ",
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

    const items = byId([item({ id: "i1", title: "Blue in Green", creator: "Miles Davis" })]);
    const names = letter({ id: "n", body: "Blue in Green by Miles Davis saved me.", bodyJa: "Blue in Green に救われた。" });

    it("lets the DJ name the work and its creator when nothing else overlaps", () => {
      const r = verifyEpisode(episode(dj("Miles Davis の Blue in Green です。")), byId([names]), me, items);
      expect(r.details).toEqual([]);
    });

    it("catches a letter copied whole even when it is mostly names", () => {
      const r = verifyEpisode(episode(dj("Blue in Green by Miles Davis saved me.")), byId([names]), me, items);
      expect(r.pii).toBe(false);
    });

    it("masks names case-insensitively", () => {
      const r = verifyEpisode(episode(dj("MILES DAVIS の blue in green です。")), byId([names]), me, items);
      expect(r.details).toEqual([]);
      expect(verifyEpisode(episode(dj("BLUE IN GREEN BY MILES DAVIS SAVED ME.")), byId([names]), me, items).pii).toBe(false);
    });

    it("catches a quote around a short title", () => {
      const thanks = byId([item({ id: "i1", title: "ありがとう", creator: "いきものがかり" })]);
      const l = letter({ id: "t", body: "本当にありがとうと伝えたかった", bodyJa: "本当にありがとうと伝えたかった" });
      expect(verifyEpisode(episode(dj("「本当にありがとうと伝えたかった」そうです。")), byId([l]), me, thanks).pii).toBe(false);
    });

    it("catches a fragment hidden with a zero-width space", () => {
      const r = verifyEpisode(episode(dj("「カセットを何度も\u200b巻き戻して」")), byId([long]), me);
      expect(r.pii).toBe(false);
    });
  });

  it("does not treat a short letter as a quote", () => {
    const short = letter({ id: "s", body: "私も", bodyJa: "私も" });
    expect(verifyEpisode(episode(dj("あおいさんから『私も』が届いています")), byId([short]), me).pii).toBe(true);
  });
});
