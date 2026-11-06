import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
import { BRIDGE_KEYS } from "../../../src/worker/program/bridge";
import { composeEpisode, FIXED_TEMPLATES, siteName } from "../../../src/worker/program/compose";
import { verifyEpisode } from "../../../src/worker/program/verify";
import { byId, item, letter, listener } from "./fixtures";

const plain = letter({ id: "a" });
const found = letter({
  id: "f",
  kind: "found",
  body: "Reminds me of home.",
  bodyJa: "故郷を思い出す。",
  lang: "en",
  radioName: "",
  place: "",
  listenerId: null,
  sourceUrl: "https://www.youtube.com/watch?v=x",
  sourceAuthor: "@jazzcat",
});
const w = (id: string, radioName: string) => letter({ id, kind: "watashimo", body: "私も", bodyJa: "私も", radioName, place: "那覇", parentLetterId: "mine" });
const reply = letter({ id: "r", kind: "reply", body: "わかります", bodyJa: "わかります", radioName: "そら", place: "熊本", parentLetterId: "mine" });
const letters = byId([plain, found, w("w1", "あおい"), w("w2", "いつき"), w("w3", "うみ"), w("w4", "えま"), reply]);
const items = byId([item({ id: "i1" }), item({ id: "i2", previewUrl: null })]);

describe("composeEpisode", () => {
  it("lays out dj, letters, the spoken found-voice source, reactions and the closing dj line", () => {
    const [seg] = composeEpisode(
      [{ itemId: "i1", slot: "near", letterIds: ["a", "f"], reactionIds: ["w1", "r"] }],
      [{ sayBefore: "はじめ", sayAfter: "おわり" }],
      letters,
      items,
    );
    expect(seg).toMatchObject({ itemId: "i1", slot: "near" });
    expect(seg!.lines).toEqual([
      { type: "dj", text: "Dococa FM。世界のどこかにいる誰かの好きなものを、お届けします。", fixed: true },
      { type: "dj", text: "はじめ" },
      { type: "letter", letterId: "a", text: plain.bodyJa, radioName: "みなと", place: "函館", kind: "letter", sourceUrl: null, sourceAuthor: null },
      { type: "dj", text: "同じ作品に、別の方からもお便りが届いています。", fixed: true },
      { type: "dj", text: "ネットで見つけた声です。@jazzcatさん、YouTubeのコメントから。", fixed: true },
      { type: "letter", letterId: "f", text: "故郷を思い出す。", radioName: "", place: "", kind: "found", sourceUrl: "https://www.youtube.com/watch?v=x", sourceAuthor: "@jazzcat" },
      { type: "dj", text: "あおいさん（那覇）から『私も』が届いています", fixed: true },
      { type: "dj", text: "そらさん（熊本）から一言が届いています", fixed: true },
      { type: "letter", letterId: "r", text: "わかります", radioName: "そら", place: "熊本", kind: "reply", sourceUrl: null, sourceAuthor: null },
      { type: "dj", text: "おわり" },
      { type: "dj", text: "ここで一息。このあとも、お便りは続きます。", fixed: true },
    ]);
  });

  it("never adds a preview clip, even for a work that has a preview url: only talk plays", () => {
    expect(items.get("i1")!.previewUrl).not.toBeNull();
    const segs = composeEpisode(
      [{ itemId: "i1", slot: "near", letterIds: ["a", "f"], reactionIds: ["w1"] }, { itemId: "i1", slot: "far", letterIds: ["f"], reactionIds: [] }],
      [{ sayBefore: "は", sayAfter: "お" }, { sayBefore: "は", sayAfter: "お" }],
      letters,
      items,
    );
    expect(segs.flatMap((s) => s.lines).every((l) => l.type === "dj" || l.type === "letter")).toBe(true);
    const fallback = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a"], reactionIds: [] }], null, letters, items);
    expect(fallback.flatMap((s) => s.lines).every((l) => l.type === "dj" || l.type === "letter")).toBe(true);
  });

  it("reads at most three reactions", () => {
    const [seg] = composeEpisode(
      [{ itemId: "i2", slot: "near", letterIds: ["a"], reactionIds: ["w1", "w2", "w3", "w4"] }],
      [{ sayBefore: "は", sayAfter: "お" }],
      letters,
      items,
    );
    expect(seg!.lines.filter((l) => l.type === "dj" && l.text.includes("私も"))).toHaveLength(3);
  });

  it("names a reaction without a radio name or place gently", () => {
    const anon = letter({ id: "x", kind: "watashimo", body: "私も", bodyJa: "私も", radioName: "", place: "" });
    const [seg] = composeEpisode([{ itemId: "i2", slot: "near", letterIds: ["a"], reactionIds: ["x"] }], null, byId([anon, plain]), items);
    expect(seg!.lines).toContainEqual({ type: "dj", text: "どなたかから『私も』が届いています", fixed: true });
  });

  it("compose_falls_back_to_readings_only", () => {
    const segs = composeEpisode(
      [
        { itemId: "i1", slot: "near", letterIds: ["a", "f"], reactionIds: [] },
        { itemId: "i2", slot: "far", letterIds: ["a"], reactionIds: [] },
      ],
      null,
      letters,
      items,
    );
    for (const seg of segs) {
      expect(seg.lines[1]).toEqual({ type: "dj", text: "みなとさん（函館）からのお便りです。", fixed: true });
      // Only template lines: the reading cue and the spoken found-voice source.
      expect(seg.lines.filter((l) => l.type === "dj").every((l) => l.type === "dj" && l.fixed === true)).toBe(true);
    }
    expect(segs[0]!.lines.filter((l) => l.type === "letter")).toHaveLength(2);
  });

  it("hands over before every named non-found letter in the readings-only fallback", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a", "b"], reactionIds: [] }], null, byId([plain, b]), items);
    const texts = seg!.lines.filter((l) => l.type === "dj").map((l) => (l as { text: string }).text);
    expect(texts).toEqual([
      t("bridge.open"),
      "みなとさん（函館）からのお便りです。",
      t("bridge.sameWork"),
      "そらさんからのお便りです。",
      t("bridge.close"),
    ]);
  });

  it("does not say 'someone' for a sender with a place but no radio name", () => {
    const p = letter({ id: "p", radioName: "", place: "函館" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["p"], reactionIds: [] }], null, byId([p]), items);
    expect(seg!.lines[1]).toEqual({ type: "dj", text: "お便りを読みます。", fixed: true });
  });

  it("throws when a plan entry has no letters", () => {
    expect(() => composeEpisode([{ itemId: "i2", slot: "near", letterIds: [], reactionIds: [] }], null, letters, items)).toThrow("segment without letters");
  });

  it("composes a reaction-only segment as just the reaction lines between the dj's", () => {
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: [], reactionIds: ["w1", "r"] }], [{ sayBefore: "は", sayAfter: "お" }], letters, items);
    expect(seg!.lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : l.type === "dj" ? l.text : l.type))).toEqual([
      t("bridge.open"),
      "は",
      "あおいさん（那覇）から『私も』が届いています",
      "そらさん（熊本）から一言が届いています",
      "letter:r",
      "お",
      t("bridge.close"),
    ]);
    expect(verifyEpisode([seg!], letters, listener(), items).details).toEqual([]);
  });

  it("keeps the plain reading cue for an anonymous sender", () => {
    const anon = letter({ id: "n", radioName: "", place: "" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["n"], reactionIds: [] }], null, byId([anon]), items);
    expect(seg!.lines[1]).toEqual({ type: "dj", text: "お便りを読みます。", fixed: true });
  });

  it.each([
    ["https://www.youtube.com/watch?v=x", "YouTube"],
    ["https://youtu.be/x", "YouTube"],
    ["https://m.youtube.com/watch?v=x", "YouTube"],
    ["https://www.reddit.com/r/jazz/1", "reddit.com"],
    ["not a url", "ウェブ"],
  ])("siteName(%s) is %s", (url, site) => {
    expect(siteName(url)).toBe(site);
  });

  it("throws when the dj lines do not match the segments", () => {
    expect(() => composeEpisode([{ itemId: "i1", slot: "near", letterIds: [], reactionIds: [] }], [], letters, items)).toThrow();
  });
});

describe("fixed templates", () => {
  it.each(FIXED_TEMPLATES)("%s says nothing the dj checks would refuse, so a fixed line never needs them", (key) => {
    const text = t(key, { who: "みなとさん（函館）", author: "@jazzcat", site: "YouTube" });
    const aLetter = { type: "letter" as const, letterId: plain.id, text: plain.bodyJa, radioName: plain.radioName, place: plain.place, kind: plain.kind, sourceUrl: null, sourceAuthor: null };
    const r = verifyEpisode([{ itemId: "i1", slot: "near", lines: [{ type: "dj", text }, aLetter] }], letters, listener());
    expect(r).toMatchObject({ topical: true, pii: true });
  });
});

describe("bridges", () => {
  const seg = (itemId: string, slot: "near" | "neighbor" | "far", letterIds: string[]) => ({ itemId, slot, letterIds, reactionIds: [] });
  const texts = (lines: { type: string }[]) => lines.map((l) => (l as { text?: string }).text);

  it("opens the first segment with the fixed open bridge and each later one by its slot", () => {
    const segs = composeEpisode([seg("i1", "far", ["a"]), seg("i2", "neighbor", ["a"]), seg("i1", "far", ["a"])], null, letters, items);
    expect(segs[0]!.lines[0]).toEqual({ type: "dj", text: t("bridge.open"), fixed: true });
    expect(segs[1]!.lines[0]).toEqual({ type: "dj", text: t("bridge.neighbor"), fixed: true });
    expect(segs[2]!.lines[0]).toEqual({ type: "dj", text: t("bridge.far"), fixed: true });
  });

  it("puts sameWork between the letters of a segment, not before the first", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const [s] = composeEpisode([seg("i1", "near", ["a", "b"])], [{ sayBefore: "", sayAfter: "" }], byId([plain, b]), items);
    expect(texts(s!.lines)).toEqual([t("bridge.open"), plain.bodyJa, t("bridge.sameWork"), b.bodyJa, t("bridge.close")]);
  });

  it("ends the episode, and only the episode, with the close bridge", () => {
    const segs = composeEpisode([seg("i1", "near", ["a"]), seg("i2", "far", ["a"])], null, letters, items);
    expect(segs[0]!.lines.at(-1)).not.toMatchObject({ text: t("bridge.close") });
    expect(segs[1]!.lines.at(-1)).toEqual({ type: "dj", text: t("bridge.close"), fixed: true });
  });

  it("uses the listener's language for the bridge lines", () => {
    const [s] = composeEpisode([seg("i1", "near", ["a"])], null, letters, items, "en");
    expect(s!.lines[0]).toEqual({ type: "dj", text: t("bridge.open", undefined, "en"), fixed: true });
    expect(s!.lines.at(-1)).toEqual({ type: "dj", text: t("bridge.close", undefined, "en"), fixed: true });
  });

  it("verifies as a whole even when a letter says 「お便り」 and the open sentence", () => {
    const chatty = letter({ id: "c", body: `${t("bridge.open")}お便りです。次は、あなたの好きなものに届いたお便りです。`, bodyJa: `${t("bridge.open")}お便りです。次は、あなたの好きなものに届いたお便りです。` });
    const segs = composeEpisode([seg("i1", "near", ["c", "a"]), seg("i2", "far", ["a"])], null, byId([chatty, plain]), items);
    expect(verifyEpisode(segs, byId([chatty, plain]), listener(), items)).toMatchObject({ verbatim: true, sources: true, topical: true, pii: true, details: [] });
  });

  it.each(BRIDGE_KEYS)("%s passes the dj checks when marked fixed", (key) => {
    const aLetter = { type: "letter" as const, letterId: plain.id, text: plain.bodyJa, radioName: plain.radioName, place: plain.place, kind: plain.kind, sourceUrl: null, sourceAuthor: null };
    const r = verifyEpisode([{ itemId: "i1", slot: "near", lines: [{ type: "dj", text: t(key), fixed: true }, aLetter] }], letters, listener());
    expect(r).toMatchObject({ topical: true, pii: true });
  });
});
