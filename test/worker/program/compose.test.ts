import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
import { BRIDGE_KEYS } from "../../../src/worker/program/bridge";
import { composeEpisode, FIXED_TEMPLATES, siteName } from "../../../src/worker/program/compose";
import { verifyEpisode } from "../../../src/worker/program/verify";
import type { Unit } from "../../../src/worker/types";
import { byId, item, letter, listener } from "./fixtures";

const unit = (letterId: string, intro: string, after: string, verified = true): Unit => ({ letterId, lang: "ja", intro, after, verified, audioReady: false, createdAt: "2026-01-01T00:00:00Z" });
const unitsOf = (...us: Unit[]): Map<string, Unit> => new Map(us.map((u) => [u.letterId, u]));

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
  it("lays out bridge, intro, hand-over, letter, after per letter, then reactions and the closing bridge", () => {
    const [seg] = composeEpisode(
      [{ itemId: "i1", slot: "near", letterIds: ["a", "f"], reactionIds: ["w1", "r"] }],
      unitsOf(unit("a", "はじめ", "おわり"), unit("f", "二通目の紹介", "二通目のあと")),
      letters,
      items,
    );
    expect(seg).toMatchObject({ itemId: "i1", slot: "near" });
    expect(seg!.lines).toEqual([
      { type: "dj", text: "Dococa FM。世界のどこかにいる誰かの好きなものへのお便りを、お届けします。", fixed: true, bridge: "bridge.open" },
      { type: "dj", text: "はじめ", unit: { letterId: "a", part: "intro" } },
      { type: "dj", text: "みなとさん（函館）からのお便りです。", fixed: true },
      { type: "letter", letterId: "a", text: plain.bodyJa, radioName: "みなと", place: "函館", kind: "letter", sourceUrl: null, sourceAuthor: null },
      { type: "dj", text: "おわり", unit: { letterId: "a", part: "after" } },
      { type: "dj", text: "同じ作品に、別の方からもお便りが届いています。", fixed: true, bridge: "bridge.sameWork" },
      // The second letter of a work has no intro of its own: the first letter's introduced the work.
      { type: "dj", text: "ネットで見つけた声です。@jazzcatさん、YouTubeのコメントから。", fixed: true },
      { type: "letter", letterId: "f", text: "故郷を思い出す。", radioName: "", place: "", kind: "found", sourceUrl: "https://www.youtube.com/watch?v=x", sourceAuthor: "@jazzcat" },
      { type: "dj", text: "二通目のあと", unit: { letterId: "f", part: "after" } },
      { type: "dj", text: "あおいさん（那覇）から『私も』が届いています", fixed: true },
      { type: "dj", text: "そらさん（熊本）から一言が届いています", fixed: true },
      { type: "letter", letterId: "r", text: "わかります", radioName: "そら", place: "熊本", kind: "reply", sourceUrl: null, sourceAuthor: null },
      { type: "dj", text: "ここで一息。", fixed: true, bridge: "bridge.close" },
    ]);
  });

  it("speaks only verified units, and fixed lines alone around a letter without one", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const plan = [{ itemId: "i1", slot: "near" as const, letterIds: ["a", "b"], reactionIds: [] }];
    const texts = (us: Map<string, Unit> | null) => composeEpisode(plan, us, byId([plain, b]), items)[0]!.lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : (l as { text: string }).text));
    const bare = [t("bridge.open"), "みなとさん（函館）からのお便りです。", "letter:a", t("bridge.sameWork"), "そらさんからのお便りです。", "letter:b", t("bridge.close")];
    expect(texts(null)).toEqual(bare);
    expect(texts(unitsOf(unit("a", "紹介", "感想", false), unit("b", "紹介b", "感想b", false)))).toEqual(bare);
    // The first letter's unit failed alone: the work is introduced by the next letter's unit, once, at the start.
    expect(texts(unitsOf(unit("a", "紹介", "感想", false), unit("b", "紹介b", "感想b")))).toEqual([
      t("bridge.open"), "紹介b", "みなとさん（函館）からのお便りです。", "letter:a", t("bridge.sameWork"), "そらさんからのお便りです。", "letter:b", "感想b", t("bridge.close"),
    ]);
    // An empty line is not said.
    expect(texts(unitsOf(unit("a", "", "感想")))).toEqual([
      t("bridge.open"), "みなとさん（函館）からのお便りです。", "letter:a", "感想", t("bridge.sameWork"), "そらさんからのお便りです。", "letter:b", t("bridge.close"),
    ]);
  });

  it("introduces the work from the first letter with a unit when a reply is read first", () => {
    const r2 = letter({ id: "r2", kind: "reply", body: "届きました", bodyJa: "届きました", radioName: "そら", place: "熊本" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["r2", "a"], reactionIds: [] }], unitsOf(unit("a", "紹介", "感想")), byId([r2, plain]), items);
    expect(seg!.lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : (l as { text: string }).text))).toEqual([
      t("bridge.open"), "紹介", "そらさん（熊本）からのお便りです。", "letter:r2", t("bridge.sameWork"), "みなとさん（函館）からのお便りです。", "letter:a", "感想", t("bridge.close"),
    ]);
  });

  it("never adds a preview clip, even for a work that has a preview url: only talk plays", () => {
    expect(items.get("i1")!.previewUrl).not.toBeNull();
    const segs = composeEpisode(
      [{ itemId: "i1", slot: "near", letterIds: ["a", "f"], reactionIds: ["w1"] }, { itemId: "i1", slot: "far", letterIds: ["f"], reactionIds: [] }],
      unitsOf(unit("a", "は", "お"), unit("f", "は", "お")),
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
      unitsOf(unit("a", "は", "お")),
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

  it("composes a reaction-only segment as the slot bridge and the reaction lines, with no DJ talk", () => {
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: [], reactionIds: ["w1", "r"] }], unitsOf(unit("r", "は", "お")), letters, items);
    expect(seg!.lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : l.type === "dj" ? l.text : l.type))).toEqual([
      t("bridge.open"),
      "あおいさん（那覇）から『私も』が届いています",
      "そらさん（熊本）から一言が届いています",
      "letter:r",
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
});

describe("composeEpisode in english", () => {
  const en = (letterId: string, intro: string, after: string): Unit => ({ ...unit(letterId, intro, after), lang: "en" });
  const placed = letter({ id: "p", bodyEn: "I listened alone at midnight.", placeCountry: "JP", placeRegion: "32" });
  const all = byId([placed, found, w("w1", "あおい"), reply, letter({ id: "n", radioName: "", place: "" })]);

  it("says every fixed line in english, reads bodyEn or the original, and names the place in english", () => {
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["p", "f", "n"], reactionIds: ["w1", "r"] }], unitsOf(en("p", "A quiet piece.", "Lovely.")), all, items, "en");
    const said = seg!.lines.map((l) => (l.type === "letter" ? `letter:${l.text}` : (l as { text: string }).text));
    expect(said).toEqual([
      t("bridge.open", undefined, "en"),
      "A quiet piece.",
      "A letter from みなと (Shimane, Japan).",
      "letter:I listened alone at midnight.",
      "Lovely.",
      t("bridge.sameWork", undefined, "en"),
      "A voice found online. @jazzcat, from a comment on YouTube.",
      "letter:Reminds me of home.",
      t("bridge.sameWork", undefined, "en"),
      "Reading the letters.",
      `letter:${plain.body}`,
      'A "me too" from あおい (那覇)',
      "A note from そら (熊本)",
      "letter:わかります",
      t("bridge.close", undefined, "en"),
    ]);
    const r = verifyEpisode([seg!], all, listener({ lang: "en" }), items, "en");
    expect(r).toEqual({ verbatim: true, sources: true, topical: true, pii: true, details: [] });
  });

  it("calls an unknown site the web in english", () => {
    expect(siteName("not a url", "en")).toBe("the web");
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
    expect(segs[0]!.lines[0]).toEqual({ type: "dj", text: t("bridge.open"), fixed: true, bridge: "bridge.open" });
    expect(segs[1]!.lines[0]).toEqual({ type: "dj", text: t("bridge.neighbor"), fixed: true, bridge: "bridge.neighbor" });
    expect(segs[2]!.lines[0]).toEqual({ type: "dj", text: t("bridge.far"), fixed: true, bridge: "bridge.far" });
  });

  it("on a public station, bridges every later segment with the neutral next, never the near one", () => {
    const segs = composeEpisode([seg("i1", "near", ["a"]), seg("i2", "near", ["a"]), seg("i1", "near", ["a"])], null, letters, items, "ja", "public");
    expect(segs[0]!.lines[0]).toMatchObject({ bridge: "bridge.open" });
    expect(segs.slice(1).map((s) => s.lines[0])).toEqual([1, 2].map(() => ({ type: "dj", text: t("bridge.next"), fixed: true, bridge: "bridge.next" })));
    const [, enSeg] = composeEpisode([seg("i1", "near", ["a"]), seg("i2", "near", ["a"])], null, letters, items, "en", "public");
    expect(enSeg!.lines[0]).toMatchObject({ text: "The next letter.", bridge: "bridge.next" });
    // Mine stays by slot.
    expect(composeEpisode([seg("i1", "near", ["a"]), seg("i2", "near", ["a"])], null, letters, items, "ja", "mine")[1]!.lines[0]).toMatchObject({ bridge: "bridge.near" });
  });

  it("puts sameWork between the letters of a segment, not before the first", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const [s] = composeEpisode([seg("i1", "near", ["a", "b"])], unitsOf(unit("a", "紹介", "感想a"), unit("b", "紹介b", "感想b")), byId([plain, b]), items);
    expect(texts(s!.lines)).toEqual([
      t("bridge.open"), "紹介", "みなとさん（函館）からのお便りです。", plain.bodyJa, "感想a",
      t("bridge.sameWork"), "そらさんからのお便りです。", b.bodyJa, "感想b", t("bridge.close"),
    ]);
  });

  it("puts a sameWork bridge between each pair of letters", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const c = letter({ id: "c", radioName: "うみ", place: "" });
    const [s] = composeEpisode([seg("i1", "near", ["a", "b", "c"])], null, byId([plain, b, c]), items);
    expect(texts(s!.lines).filter((x) => x === t("bridge.sameWork"))).toHaveLength(2);
  });

  it("adds no sameWork bridge for a letter id that is missing", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const [s] = composeEpisode([seg("i1", "near", ["a", "gone", "b"])], null, byId([plain, b]), items);
    expect(texts(s!.lines).filter((x) => x === t("bridge.sameWork"))).toHaveLength(1);
    const [s2] = composeEpisode([seg("i1", "near", ["a", "gone"])], null, byId([plain]), items);
    expect(texts(s2!.lines).filter((x) => x === t("bridge.sameWork"))).toHaveLength(0);
  });

  it("ends the episode, and only the episode, with the close bridge", () => {
    const segs = composeEpisode([seg("i1", "near", ["a"]), seg("i2", "far", ["a"])], null, letters, items);
    expect(segs[0]!.lines.at(-1)).not.toMatchObject({ text: t("bridge.close") });
    expect(segs[1]!.lines.at(-1)).toEqual({ type: "dj", text: t("bridge.close"), fixed: true, bridge: "bridge.close" });
  });

  it("uses the listener's language for the bridge lines", () => {
    const [s] = composeEpisode([seg("i1", "near", ["a"])], null, letters, items, "en");
    expect(s!.lines[0]).toEqual({ type: "dj", text: t("bridge.open", undefined, "en"), fixed: true, bridge: "bridge.open" });
    expect(s!.lines.at(-1)).toEqual({ type: "dj", text: t("bridge.close", undefined, "en"), fixed: true, bridge: "bridge.close" });
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
