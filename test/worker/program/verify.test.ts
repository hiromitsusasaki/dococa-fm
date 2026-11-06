import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
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

describe("verifyEpisode playback words", () => {
  it.each(["次はこの曲をかけます", "どうぞ", "お聴きください", "この曲をかけてください", "かけてみましょう", "聴いてみてください", "この曲を再生します", "再生しましょう", "お聞きください", "観てみてください", "流してみましょう", "流しましょう", "この曲をおかけします"])("fails a dj line %s with playback:", (text) => {
    const r = verifyEpisode(episode(dj(text), read(plain)), letters, me);
    expect(r.topical).toBe(false);
    expect(r.details.some((d) => d.startsWith("playback: segment 1 line 1: "))).toBe(true);
  });

  it("does not read a work title as talk", () => {
    const titled = byId([item({ id: "i1", title: "どうぞこのまま" })]);
    const r = verifyEpisode(episode(dj("『どうぞこのまま』という映画です。"), read(plain)), letters, me, titled);
    expect(r.details.filter((d) => d.startsWith("playback:"))).toEqual([]);
  });

  it("quote-checks only the filled values of a hand-over that says where the sender lives", () => {
    const echo = letter({ id: "e", radioName: "ゆう", place: "", body: "函館にお住まいの、みなとさんからのお便りです。", bodyJa: "函館にお住まいの、みなとさんからのお便りです。" });
    const r = verifyEpisode(episode(fixedDj("函館にお住まいの、みなとさんからのお便りです。"), read(echo)), byId([plain, echo]), me);
    expect(r.verbatim).toBe(true);
    expect(r.details).toEqual([]);
  });

  it("still flags a hand-over whose filled name is quoted from a letter", () => {
    const name = "あおいあおいあおいあおいあおい";
    const sender = letter({ id: "s", radioName: name, place: "那覇", body: "別の話です。", bodyJa: "別の話です。" });
    const quoting = letter({ id: "q", radioName: "ゆう", place: "", body: `那覇のあおいです。${name}さん、また会おう。`, bodyJa: `那覇のあおいです。${name}さん、また会おう。` });
    const r = verifyEpisode(episode(fixedDj(`那覇にお住まいの、${name}さんからのお便りです。`), read(quoting)), byId([sender, quoting]), me);
    expect(r.pii).toBe(false);
    expect(r.details.some((d) => d.includes("quotes a letter"))).toBe(true);
  });

  it("exempts fixed lines", () => {
    expect(verifyEpisode(episode(fixedDj("お便りを読みます。どうぞ"), read(plain)), letters, me).details.filter((d) => d.startsWith("playback:"))).toEqual([]);
  });

  it.each([
    "続いては、ポルトの Azulejo Sunday さんから、『ニュー・シネマ・パラダイス』へのお便り",
    "この映画は私にはファドのように聴こえる",
    "語りかけるような歌声",
    "問いかける映画",
    "涙を流します",
    "どうぞよろしく",
    "街で見かける人たちの話",
    "旅に出かける日の歌",
    "罠を仕かける映画",
    "押しかけるファンの声",
    "腰かけて聴く人もいる",
    "ご迷惑をおかけします",
    "再生した古い街の映画",
    "雨音を聞き流します",
  ])("passes %s", (text) => {
    expect(verifyEpisode(episode(dj(text), read(plain)), letters, me).details.filter((d) => d.startsWith("playback:"))).toEqual([]);
  });
});

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

  it("verbatim checks the place codes when the line has them, and accepts older lines without", () => {
    const placed = letter({ id: "p", placeCountry: "JP", placeRegion: "32" });
    const all = byId([placed]);
    const line = { ...(read(placed) as object), placeCountry: "JP", placeRegion: "32" } as ScriptLine;
    expect(verifyEpisode(episode(line), all, me).verbatim).toBe(true);
    expect(verifyEpisode(episode(read(placed)), all, me).verbatim).toBe(true);
    expect(verifyEpisode(episode({ ...line, placeRegion: "13" } as ScriptLine), all, me).verbatim).toBe(false);
    expect(verifyEpisode(episode({ ...line, placeCountry: "US" } as ScriptLine), all, me).verbatim).toBe(false);
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

  it.each([
    "3曲続けてどうぞ。",
    "３曲続けてどうぞ。",
    "10曲目の歌です。",
    "三作品を並べて。",
    "2冊読みました。",
    "二冊目の本です。",
    "4本の映画から。",
    "四本立てで。",
    "5枚のアルバム。",
    "十二話あるドラマ。",
    "何曲も聴いた人が。",
  ])("counting works fails: %s", (text) => {
    const r = verifyEpisode(episode(dj(text)), letters, me);
    expect(r.topical).toBe(false);
    expect(r.details.some((d) => d.startsWith("measure:"))).toBe(true);
  });

  it.each(["静かな一曲です。", "一本の映画のような夜。", "一冊の本を閉じたあと。", "1曲だけ。", "第一話のような始まり。", "日本の歌です。"])(
    "naming one work is not a count: %s",
    (text) => {
      expect(verifyEpisode(episode(dj(text)), letters, me).topical).toBe(true);
    },
  );

  it("does not take a title or creator for a count or a date", () => {
    const named = byId([item({ id: "i1", title: "千本桜", creator: "今夜の楽団", year: null })]);
    expect(verifyEpisode(episode(dj("千本桜を、今夜の楽団で。")), letters, me, named).topical).toBe(true);
    expect(verifyEpisode(episode(dj("千本桜を3曲。")), letters, me, named).topical).toBe(false);
  });

  it.each([
    ["新宿区西新宿2丁目8番1号に住んでいるそうです。", "street address"],
    ["西新宿二丁目八番一号から。", "street address"],
    ["新宿区西新宿2-8-1のあたり。", "street address"],
    ["本町3番地の店で。", "street address"],
    ["西新宿2-8-1", "street address"],
    ["西新宿2丁目8番1号", "street address"],
    ["〒163-8001 から届きました。", "postal code"],
    ["〒1638001 から届きました。", "postal code"],
    ["163-8001 まで。", "postal code"],
  ])("a dj line with an address or postal code fails pii: %s", (text, what) => {
    const r = verifyEpisode(episode(dj(text)), letters, me);
    expect(r.pii).toBe(false);
    expect(r.details.some((d) => d.endsWith(what))).toBe(true);
  });

  it.each(["2丁目のカフェで聴いた歌です。", "十八番の一曲です。", "一番好きな歌です。", "3番線のホームで。", "武道館で 2-1", "下町で 1990-95 年", "武道館で2-1"])("a place without a lot number passes: %s", (text) => {
    expect(verifyEpisode(episode(dj(text)), letters, me).pii).toBe(true);
  });

  it("leaves fixed lines out of the address and postal checks", () => {
    expect(verifyEpisode(episode(fixedDj("みなとさん（本町3番地）から『私も』が届いています")), letters, me).pii).toBe(true);
  });

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

  describe("handing over in a segment with no letter", () => {
    const wm = fixedDj("あおいさん（那覇）から『私も』が届いています");
    it("fails a hand-over over a reaction-only segment", () => {
      const r = verifyEpisode(episode(dj("しずくさんからのお便りです。"), wm), letters, me);
      expect(r.topical).toBe(false);
      expect(r.details).toEqual(["announce: segment 1 line 1: hands over to a letter in a segment with none"]);
    });
    it("lets the DJ say the listener's own letter got a reaction", () => {
      expect(verifyEpisode(episode(dj("あなたのお便りに反応が届いています。"), wm), letters, me).details).toEqual([]);
    });
    it("does not apply once the segment reads a letter, a reply included", () => {
      expect(verifyEpisode(episode(dj("しずくさんからのお便りです。"), read(plain)), letters, me).details).toEqual([]);
      const reply = { ...plain, kind: "reply" as const };
      expect(verifyEpisode(episode(dj("そらさんからのお便りです。"), read(reply)), new Map([[reply.id, reply]]), me).details).not.toContainEqual(expect.stringMatching(/^announce:/));
    });
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

describe("verifyEpisode bridge lines", () => {
  it("does not fail the open bridge because a letter contains its exact sentence", () => {
    const open = t("bridge.open");
    const echo = letter({ id: "echo", body: open, bodyJa: open });
    const r = verifyEpisode(episode(fixedDj(open), read(echo)), byId([echo]), me);
    expect(r).toMatchObject({ pii: true, topical: true });
    expect(r.details).toEqual([]);
  });

  it("still fails a non-fixed dj line that quotes the same sentence", () => {
    const open = t("bridge.open");
    const echo = letter({ id: "echo", body: open, bodyJa: open });
    expect(verifyEpisode(episode(dj(open), read(echo)), byId([echo]), me).pii).toBe(false);
  });
});

describe("verifyEpisode intro names the sender", () => {
  const intro = (text: string, letterId: string): ScriptLine => ({ type: "dj", text, unit: { letterId, part: "intro" } });
  const after = (text: string, letterId: string): ScriptLine => ({ type: "dj", text, unit: { letterId, part: "after" } });
  const placed = letter({ id: "p", radioName: "Minato", place: "北海道", placeCountry: "JP", placeRegion: "01", bodyEn: "I listened alone at midnight." });
  const run = (lines: ScriptLine[], lang: "ja" | "en", l = plain) => verifyEpisode([{ itemId: "i1", slot: "near", lines }], byId([l]), me, new Map([["i1", item()]]), lang);

  it.each([
    ["ja", "みなとさんが選んだ一曲です。", plain],
    ["ja", "函館の夜に似合う一曲です。", plain],
    ["ja", "北海道の冬に似合う一曲です。", placed],
    ["en", "minato picked a quiet one.", placed],
    ["en", "A song for a night in Hokkaido, Japan.", placed],
    ["en", "A song for nights in 函館.", plain],
  ] as const)("fails a %s intro that names the sender or the place: %s", (lang, text, l) => {
    const r = run([intro(text, l.id), read(l, lang === "en" ? (l.bodyEn ?? l.body) : l.bodyJa)], lang, l);
    expect(r.topical).toBe(false);
    expect(r.details).toContain("intro: segment 1 line 1: names the sender");
    expect(r.details.join("\n")).not.toMatch(/みなと|minato|函館|hokkaido|北海道/i);
  });

  it("lets an intro name the work's title and creator, and lets an after mention the sender", () => {
    expect(run([intro("Miles Davis の Blue in Green です。", plain.id), read(plain), after("みなとさん、ありがとう。", plain.id)], "ja").details).toEqual([]);
    expect(run([intro("Blue in Green, by Miles Davis.", placed.id), read(placed, placed.bodyEn!)], "en", placed).details).toEqual([]);
  });

  it.each([
    ["ja", "日本のジャズの名盤です。", letter({ id: "c1", radioName: "", place: "日本" })],
    ["ja", "日本のジャズの名盤です。", letter({ id: "c2", radioName: "", place: "日本", placeCountry: "JP", placeRegion: null })],
    ["ja", "日本のジャズの名盤です。", letter({ id: "c3", radioName: "", place: "東京", placeCountry: "JP", placeRegion: "13" })],
    ["en", "A classic of Japanese jazz.", letter({ id: "c4", radioName: "", place: "Japan", bodyEn: "x" })],
    ["en", "A classic of Japanese jazz.", letter({ id: "c5", radioName: "", place: "東京", placeCountry: "JP", placeRegion: "13", bodyEn: "x" })],
    ["en", "A song from Scotland.", letter({ id: "c6", radioName: "", place: "スコットランド", bodyEn: "x" })],
    ["en", "A song from Scotland.", letter({ id: "c7", radioName: "", place: "Scotland", bodyEn: "x" })],
    ["ja", "ポルトガルのファドです。", letter({ id: "c8", radioName: "", place: "ポルトガル", placeCountry: "PT" })],
  ] as const)("lets a %s intro name a country: %s (%s)", (lang, text, l) => {
    expect(run([intro(text, l.id), read(l, lang === "en" ? (l.bodyEn ?? l.body) : l.bodyJa)], lang, l).details.filter((d) => d.startsWith("intro:"))).toEqual([]);
  });

  it.each([
    ["ja", "東京の夜に似合う一曲です。"],
    ["ja", "東京都の夜に似合う一曲です。"],
    ["en", "A song for a night in Tokyo."],
  ] as const)("fails a %s intro that names the sender's region: %s", (lang, text) => {
    const tokyo = letter({ id: "t", radioName: "", place: "東京", placeCountry: "JP", placeRegion: "13", bodyEn: "x" });
    expect(run([intro(text, tokyo.id), read(tokyo, lang === "en" ? "x" : tokyo.bodyJa)], lang, tokyo).details).toContain("intro: segment 1 line 1: names the sender");
  });

  it("masks the work's title and creator first: 東京事変 passes for a Tokyo sender, 東京の夜 still fails", () => {
    const tokyo = letter({ id: "t", radioName: "", place: "東京", placeCountry: "JP", placeRegion: "13" });
    const works = new Map([["i1", item({ title: "群青日和", creator: "東京事変" })]]);
    const check = (text: string) => verifyEpisode([{ itemId: "i1", slot: "near", lines: [intro(text, tokyo.id), read(tokyo)] }], byId([tokyo]), me, works, "ja").details.filter((d) => d.startsWith("intro:"));
    expect(check("東京事変の群青日和です。")).toEqual([]);
    expect(check("東京の夜に似合う東京事変の一曲です。")).toEqual(["intro: segment 1 line 1: names the sender"]);
  });

  it("ignores a one-character radio name", () => {
    const short = letter({ id: "s", radioName: "海", place: "" });
    expect(run([intro("海の見える部屋で聴きたい一曲です。", short.id), read(short)], "ja", short).details).toEqual([]);
  });
});

describe("verifyEpisode japanese gaps", () => {
  const details = (text: string) => verifyEpisode(episode(dj(text), read(plain)), letters, me).details;

  it.each([
    ["measure", "二通のお便りです。"],
    ["measure", "三通のお便りが届きました。"],
    ["playback", "一緒に聴きましょう。"],
    ["playback", "ゆっくり聞きましょう。"],
    ["playback", "この映画を観ましょう。"],
    ["playback", "ぜひ見ましょう。"],
    ["playback", "聴いてみてね。"],
    ["playback", "聞いてほしい一曲です。"],
    ["playback", "観てみましょう。"],
    ["playback", "見てね。"],
    ["topical", "ただいまお届けするのは静かな一曲です。"],
    ["topical", "只今お届けしているのは静かな曲です。"],
  ])("fails with %s: %s", (check, text) => {
    expect(details(text).some((d) => d.startsWith(`${check}: segment 1 line 1: `))).toBe(true);
  });

  it.each(["一通のお便りです。", "世界のどこかの一通を。", "ずっと聴いてきた人の一曲です。", "夜に聴いてきた歌です。"])("passes %s", (text) => {
    expect(details(text)).toEqual([]);
  });
});
