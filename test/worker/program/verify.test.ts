import { describe, expect, it } from "vitest";
import { verifyEpisode } from "../../../src/worker/program/verify";
import type { ScriptLine, Segment } from "../../../src/worker/types";
import { byId, letter, listener } from "./fixtures";

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

  it.each(["三人の方から届きました。", "5通のお便りが来ています。", "ランキング一位の曲です。", "一致率の高い一曲。"])("a count or ranking fails: %s", (text) => {
    expect(verifyEpisode(episode(dj(text)), letters, me).topical).toBe(false);
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

  it("does not treat a short letter as a quote", () => {
    const short = letter({ id: "s", body: "私も", bodyJa: "私も" });
    expect(verifyEpisode(episode(dj("あおいさんから『私も』が届いています")), byId([short]), me).pii).toBe(true);
  });
});
