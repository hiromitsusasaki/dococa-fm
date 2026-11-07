import { describe, expect, it } from "vitest";
import { t } from "../../../src/worker/i18n/t";
import { BRIDGE_KEYS } from "../../../src/worker/program/bridge";
import { applyReadings, composeEpisode, FIXED_TEMPLATES, leadLine, read, siteName } from "../../../src/worker/program/compose";
import { verifyEpisode } from "../../../src/worker/program/verify";
import type { Unit } from "../../../src/worker/types";
import { byId, item, letter, listener } from "./fixtures";

const unit = (letterId: string, intro: string, after: string, verified = true): Unit => ({ letterId, lang: "ja", intro, after, verified, audioReady: false, createdAt: "2026-01-01T00:00:00Z" });
/** The fixed lead the fixture work gets, said before the first letter of each segment. */
const LEAD = "Miles Davisの「Blue in Green」という曲の紹介です。";
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
  it("lays out bridge, lead, intro, hand-over, letter, after, then reactions, with no closing bridge", () => {
    const [seg] = composeEpisode(
      [{ itemId: "i1", slot: "near", letterIds: ["a"], reactionIds: ["w1", "r"] }],
      unitsOf(unit("a", "はじめ", "おわり"), unit("f", "二通目の紹介", "二通目のあと")),
      letters,
      items,
    );
    expect(seg).toMatchObject({ itemId: "i1", slot: "near" });
    expect(seg!.lines).toEqual([
      { type: "dj", text: "Dococa FM。世界のどこかにいる誰かの好きなものへのお便りを、お届けします。", fixed: true, bridge: "bridge.open" },
      { type: "dj", text: LEAD, fixed: true },
      { type: "dj", text: "はじめ", unit: { letterId: "a", part: "intro" } },
      { type: "dj", text: "函館にお住まいの、みなとさんからのお便りです。", fixed: true },
      { type: "letter", letterId: "a", text: plain.bodyJa, radioName: "みなと", place: "函館", kind: "letter", sourceUrl: null, sourceAuthor: null },
      { type: "dj", text: "おわり", unit: { letterId: "a", part: "after" } },
      { type: "dj", text: "那覇にお住まいの、あおいさんから『私も』が届いています", fixed: true },
      { type: "dj", text: "熊本にお住まいの、そらさんから一言が届いています", fixed: true },
      { type: "letter", letterId: "r", text: "わかります", radioName: "そら", place: "熊本", kind: "reply", sourceUrl: null, sourceAuthor: null },
    ]);
  });

  it("speaks only verified units, and fixed lines alone around a letter without one", () => {
    const plan = [{ itemId: "i1", slot: "near" as const, letterIds: ["a"], reactionIds: [] }];
    const texts = (us: Map<string, Unit> | null) => composeEpisode(plan, us, byId([plain]), items)[0]!.lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : (l as { text: string }).text));
    const bare = [t("bridge.open"), LEAD, "函館にお住まいの、みなとさんからのお便りです。", "letter:a"];
    expect(texts(null)).toEqual(bare);
    expect(texts(unitsOf(unit("a", "紹介", "感想", false)))).toEqual(bare);
    expect(texts(unitsOf(unit("a", "紹介", "感想")))).toEqual([t("bridge.open"), LEAD, "紹介", "函館にお住まいの、みなとさんからのお便りです。", "letter:a", "感想"]);
    // An empty line is not said.
    expect(texts(unitsOf(unit("a", "", "感想")))).toEqual([...bare, "感想"]);
  });

  it("reads one letter per segment: the first the plan names that is there, never a sameWork bridge", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const said = (letterIds: string[]) =>
      composeEpisode([{ itemId: "i1", slot: "near", letterIds, reactionIds: [] }], unitsOf(unit("a", "紹介a", "感想a"), unit("b", "紹介b", "感想b")), byId([plain, b]), items)[0]!.lines.map((l) =>
        l.type === "letter" ? `letter:${l.letterId}` : (l as { text: string }).text,
      );
    expect(said(["a", "b"])).toEqual([t("bridge.open"), LEAD, "紹介a", "函館にお住まいの、みなとさんからのお便りです。", "letter:a", "感想a"]);
    expect(said(["gone", "b"])).toEqual([t("bridge.open"), LEAD, "紹介b", "そらさんからのお便りです。", "letter:b", "感想b"]);
    expect(said(["a", "b"]).filter((x) => x.startsWith("letter:"))).toHaveLength(1);
  });

  it("introduces the work with the first letter's own intro", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a", "b"], reactionIds: [] }], unitsOf(unit("a", "紹介a", "感想a"), unit("b", "紹介b", "感想b")), byId([plain, b]), items);
    const intros = seg!.lines.filter((l) => l.type === "dj" && l.unit?.part === "intro");
    expect(intros).toEqual([{ type: "dj", text: "紹介a", unit: { letterId: "a", part: "intro" } }]);
    expect(seg!.lines[2]).toEqual(intros[0]);
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
      expect(seg.lines[2]).toEqual({ type: "dj", text: "函館にお住まいの、みなとさんからのお便りです。", fixed: true });
      // Only template lines: the reading cue and the spoken found-voice source.
      expect(seg.lines.filter((l) => l.type === "dj").every((l) => l.type === "dj" && l.fixed === true)).toBe(true);
    }
    expect(segs[0]!.lines.filter((l) => l.type === "letter")).toHaveLength(1);
  });

  it("hands over before the letter in the readings-only fallback", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["b"], reactionIds: [] }], null, byId([b]), items);
    const texts = seg!.lines.filter((l) => l.type === "dj").map((l) => (l as { text: string }).text);
    expect(texts).toEqual([t("bridge.open"), LEAD, "そらさんからのお便りです。"]);
  });

  it("does not say 'someone' for a sender with a place but no radio name", () => {
    const p = letter({ id: "p", radioName: "", place: "函館" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["p"], reactionIds: [] }], null, byId([p]), items);
    expect(seg!.lines[2]).toEqual({ type: "dj", text: "お便りを読みます。", fixed: true });
  });

  it("throws when a plan entry has no letters", () => {
    expect(() => composeEpisode([{ itemId: "i2", slot: "near", letterIds: [], reactionIds: [] }], null, letters, items)).toThrow("segment without letters");
  });

  it("composes a reaction-only segment as the slot bridge and the reaction lines, with no DJ talk", () => {
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: [], reactionIds: ["w1", "r"] }], unitsOf(unit("r", "は", "お")), letters, items);
    expect(seg!.lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : l.type === "dj" ? l.text : l.type))).toEqual([
      t("bridge.open"),
      "那覇にお住まいの、あおいさんから『私も』が届いています",
      "熊本にお住まいの、そらさんから一言が届いています",
      "letter:r",
    ]);
    expect(verifyEpisode([seg!], letters, listener(), items).details).toEqual([]);
  });

  it("keeps the plain reading cue for an anonymous sender", () => {
    const anon = letter({ id: "n", radioName: "", place: "" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["n"], reactionIds: [] }], null, byId([anon]), items);
    expect(seg!.lines[2]).toEqual({ type: "dj", text: "お便りを読みます。", fixed: true });
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
    const segs = composeEpisode(
      [
        { itemId: "i1", slot: "near", letterIds: ["p"], reactionIds: ["w1", "r"] },
        { itemId: "i1", slot: "near", letterIds: ["f"], reactionIds: [] },
        { itemId: "i1", slot: "near", letterIds: ["n"], reactionIds: [] },
      ],
      unitsOf(en("p", "A quiet piece.", "Lovely.")),
      all,
      items,
      "en",
    );
    const said = segs.flatMap((s) => s.lines).map((l) => (l.type === "letter" ? `letter:${l.text}` : (l as { text: string }).text));
    expect(said).toEqual([
      t("bridge.open", undefined, "en"),
      "Here is “Blue in Green”, a song by Miles Davis.",
      "A quiet piece.",
      "A letter from みなと, who lives in Shimane, Japan.",
      "letter:I listened alone at midnight.",
      "Lovely.",
      'A "me too" from あおい, who lives in 那覇',
      "A note from そら, who lives in 熊本",
      "letter:わかります",
      t("bridge.near", undefined, "en"),
      "Here is “Blue in Green”, a song by Miles Davis.",
      "A voice found online. @jazzcat, from a comment on YouTube.",
      "letter:Reminds me of home.",
      t("bridge.near", undefined, "en"),
      "Here is “Blue in Green”, a song by Miles Davis.",
      "Reading the letters.",
      `letter:${plain.body}`,
    ]);
    const r = verifyEpisode(segs, all, listener({ lang: "en" }), items, "en");
    expect(r).toEqual({ verbatim: true, sources: true, topical: true, pii: true, details: [] });
  });

  it("calls an unknown site the web in english", () => {
    expect(siteName("not a url", "en")).toBe("the web");
  });
});

describe("saying where a sender lives", () => {
  const minato = letter({ id: "m", radioName: "みなと", place: "東京" });
  const say = (lang: "ja" | "en", ...ls: ReturnType<typeof letter>[]) =>
    composeEpisode([{ itemId: "i1", slot: "near" as const, letterIds: [ls[0]!.id], reactionIds: ls.slice(1).map((l) => l.id) }], null, byId(ls), items, lang)[0]!.lines.flatMap((l) => (l.type === "dj" ? [l.text] : []));

  it("hands over a named sender with the place said as where they live", () => {
    expect(say("ja", minato)).toContain("東京にお住まいの、みなとさんからのお便りです。");
    expect(say("en", { ...minato, placeCountry: "JP", placeRegion: "13" })).toContain("A letter from みなと, who lives in Tokyo, Japan.");
  });

  it("keeps the plain hand-over when there is no place", () => {
    expect(say("ja", { ...minato, place: "" })).toContain("みなとさんからのお便りです。");
  });

  it("says reactions with the same phrase", () => {
    const wm = letter({ id: "x", kind: "watashimo", radioName: "みなと", place: "東京", parentLetterId: "m" });
    expect(say("ja", plain, wm)).toContain("東京にお住まいの、みなとさんから『私も』が届いています");
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

  it("has no sameWork bridge any more: each letter airs in its own segment", () => {
    expect(BRIDGE_KEYS as readonly string[]).not.toContain("bridge.sameWork");
    expect(FIXED_TEMPLATES as readonly string[]).not.toContain("bridge.sameWork");
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const segs = composeEpisode([seg("i1", "near", ["a", "b"]), seg("i1", "near", ["b"])], null, byId([plain, b]), items);
    expect(segs.flatMap((s) => s.lines).some((l) => (l as { bridge?: string }).bridge === "bridge.sameWork")).toBe(false);
    expect(texts(segs[0]!.lines)).toEqual([t("bridge.open"), LEAD, "函館にお住まいの、みなとさんからのお便りです。", plain.bodyJa]);
  });

  it("never says the close bridge: a programme has no end the DJ can know", () => {
    const segs = composeEpisode([seg("i1", "near", ["a"]), seg("i2", "far", ["a"])], null, letters, items);
    expect(segs.flatMap((s) => s.lines).some((l) => (l as { bridge?: string }).bridge === "bridge.close")).toBe(false);
  });

  it("opens only the first programme of a visit; a later one starts with its slot bridge", () => {
    const [later] = composeEpisode([seg("i2", "far", ["a"])], null, letters, items, "ja", "mine", { first: false });
    expect(later!.lines[0]).toEqual({ type: "dj", text: t("bridge.far"), fixed: true, bridge: "bridge.far" });
    const [firstOne] = composeEpisode([seg("i2", "far", ["a"])], null, letters, items, "ja", "mine", { first: true });
    expect(firstOne!.lines[0]).toMatchObject({ bridge: "bridge.open" });
  });

  it("a first programme that leads with an asked letter has no opening and no bridge; a later one keeps its slot bridge", () => {
    const [firstOne] = composeEpisode([seg("i2", "far", ["a"])], null, letters, items, "ja", "mine", { first: true, asked: true });
    expect(firstOne!.lines.some((l) => (l as { bridge?: string }).bridge !== undefined)).toBe(false);
    const [later] = composeEpisode([seg("i2", "far", ["a"])], null, letters, items, "ja", "mine", { first: false, asked: true });
    expect(later!.lines[0]).toMatchObject({ bridge: "bridge.far" });
  });

  it("uses the listener's language for the bridge lines", () => {
    const [s] = composeEpisode([seg("i1", "near", ["a"])], null, letters, items, "en");
    expect(s!.lines[0]).toEqual({ type: "dj", text: t("bridge.open", undefined, "en"), fixed: true, bridge: "bridge.open" });
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

describe("read", () => {
  it("carries the letter's place codes when it has them, and leaves them out when it does not", () => {
    expect(read(letter({ placeCountry: "JP", placeRegion: "01" }))).toMatchObject({ type: "letter", place: "函館", placeCountry: "JP", placeRegion: "01" });
    expect(read(letter({ placeCountry: "PT", placeRegion: null }))).toMatchObject({ placeCountry: "PT" });
    expect(read(letter({ placeCountry: "PT", placeRegion: null }))).not.toHaveProperty("placeRegion");
    const bare = read(letter());
    expect(bare).not.toHaveProperty("placeCountry");
    expect(bare).not.toHaveProperty("placeRegion");
  });
});

describe("lead line", () => {
  it.each([
    ["music", "ja", "Miles Davisの「Blue in Green」という曲の紹介です。"],
    ["book", "ja", "Miles Davisの「Blue in Green」という本の紹介です。"],
    ["film", "ja", "Miles Davisの「Blue in Green」という映画の紹介です。"],
    ["video", "ja", "Miles Davisの「Blue in Green」という動画の紹介です。"],
    ["music", "en", "Here is “Blue in Green”, a song by Miles Davis."],
    ["book", "en", "Here is “Blue in Green”, a book by Miles Davis."],
    ["film", "en", "Here is “Blue in Green”, a film by Miles Davis."],
    ["video", "en", "Here is “Blue in Green”, a video by Miles Davis."],
  ] as const)("names a %s work by its kind in %s", (kind, lang, text) => {
    expect(leadLine(item({ kind }), lang)).toEqual({ type: "dj", text, fixed: true });
  });

  it("drops the creator when there is none", () => {
    expect(leadLine(item({ creator: " " }), "ja").text).toBe("「Blue in Green」という曲の紹介です。");
    expect(leadLine(item({ kind: "film", creator: "" }), "en").text).toBe("Here is “Blue in Green”, a film.");
  });

  it("has a template for videos too", () => {
    expect(t("script.lead.video", { creator: "A", title: "B" })).toBe("Aの「B」という動画の紹介です。");
    expect(t("script.lead.video.noCreator", { title: "B" }, "en")).toBe("Here is “B”, a video.");
  });

  it("opens each segment's letters before the intro, with or without a unit", () => {
    const lead = { type: "dj", text: "Miles Davisの「Blue in Green」という曲の紹介です。", fixed: true };
    const [withUnit] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a"], reactionIds: [] }], unitsOf(unit("a", "紹介", "感想")), byId([plain]), items);
    expect(withUnit!.lines.slice(0, 3)).toEqual([expect.objectContaining({ bridge: "bridge.open" }), lead, { type: "dj", text: "紹介", unit: { letterId: "a", part: "intro" } }]);
    const [bare] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a"], reactionIds: [] }], null, byId([plain]), items);
    expect(bare!.lines[1]).toEqual(lead);
    const [asked] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a"], reactionIds: [] }], null, byId([plain]), items, "ja", "mine", { first: true, asked: true });
    expect(asked!.lines[0]).toEqual(lead);
  });

  it("is said once per segment, not before a second letter, and not in a segment of reactions only", () => {
    const b = letter({ id: "b", radioName: "そら", place: "" });
    const [seg] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a", "b"], reactionIds: [] }], null, byId([plain, b]), items);
    expect(seg!.lines.filter((l) => l.type === "dj" && l.text.endsWith("という曲の紹介です。"))).toHaveLength(1);
    const [only] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: [], reactionIds: ["w1"] }], null, letters, items);
    expect(only!.lines.some((l) => l.type === "dj" && l.text.endsWith("という曲の紹介です。"))).toBe(false);
  });

  it("passes the checks even when a letter contains the title", () => {
    const titled = letter({ id: "t", body: "Blue in Greenを夜中に聴いて泣いた。", bodyJa: "Blue in Greenを夜中に聴いて泣いた。" });
    const segs = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["t"], reactionIds: [] }], null, byId([titled]), items);
    expect(verifyEpisode(segs, byId([titled]), listener(), items)).toMatchObject({ topical: true, pii: true, details: [] });
  });
});

describe("readings for the voice", () => {
  const psy = item({ id: "p1", title: "Gangnam Style", creator: "PSY", readingJa: { creator: "サイ" } });
  const fan = letter({ id: "g", itemId: "p1", body: "PSYで踊った夏。", bodyJa: "PSYで踊った夏。" });
  const plan = [{ itemId: "p1", slot: "near" as const, letterIds: ["g"], reactionIds: [] }];
  const u = { ...unit("g", "PSYらしい明るい一曲です。", "Gangnam Styleで踊った夏、いいですね。"), readings: [{ text: "Gangnam Style", reading: "カンナムスタイル" }] };

  it("replaces exact strings, the longest first, in one pass", () => {
    expect(applyReadings("PSYとPSY2", [{ text: "PSY", reading: "サイ" }, { text: "PSY2", reading: "サイツー" }])).toBe("サイとサイツー");
    expect(applyReadings("サイのPSY", [{ text: "PSY", reading: "サイ" }, { text: "サイ", reading: "X" }])).toBe("Xのサイ");
    expect(applyReadings("静かな曲", [])).toBe("静かな曲");
  });

  it("gives the lead, the intro and the after a spoken text with the readings, and keeps the written text", () => {
    const [seg] = composeEpisode(plan, unitsOf(u), byId([fan]), byId([psy]));
    const lines = seg!.lines.slice(1);
    expect(lines[0]).toEqual({ type: "dj", text: "PSYの「Gangnam Style」という曲の紹介です。", spoken: "サイの「Gangnam Style」という曲の紹介です。", fixed: true });
    expect(lines[1]).toEqual({ type: "dj", text: "PSYらしい明るい一曲です。", spoken: "サイらしい明るい一曲です。", unit: { letterId: "g", part: "intro" } });
    expect(lines[4]).toEqual({ type: "dj", text: "Gangnam Styleで踊った夏、いいですね。", spoken: "カンナムスタイルで踊った夏、いいですね。", unit: { letterId: "g", part: "after" } });
  });

  it("never gives a letter line or a hand-over a spoken text, even when they carry the name", () => {
    const [seg] = composeEpisode(plan, unitsOf(u), byId([fan]), byId([psy]));
    for (const l of seg!.lines) if (l.type === "letter" || (l.type === "dj" && l.fixed && !l.text.includes("紹介"))) expect(l).not.toHaveProperty("spoken");
    expect(seg!.lines.find((l) => l.type === "letter")).toMatchObject({ text: "PSYで踊った夏。" });
  });

  it("gives no spoken text when no reading applies, nor in English", () => {
    const [ja] = composeEpisode([{ itemId: "i1", slot: "near", letterIds: ["a"], reactionIds: [] }], unitsOf(unit("a", "静かな一曲です。", "いいですね。")), letters, items);
    expect(ja!.lines.some((l) => l.type === "dj" && "spoken" in l)).toBe(false);
    const [en] = composeEpisode(plan, unitsOf({ ...u, lang: "en" }), byId([fan]), byId([psy]), "en");
    expect(en!.lines.some((l) => l.type === "dj" && "spoken" in l)).toBe(false);
  });

  it("reads the sender's place in the hand-over with the unit's readings, and keeps its text", () => {
    const far = letter({ id: "o", itemId: "p1", radioName: "そら", place: "大船渡", body: "夏の夜。", bodyJa: "夏の夜。" });
    const [seg] = composeEpisode([{ itemId: "p1", slot: "near", letterIds: ["o"], reactionIds: [] }], unitsOf({ ...unit("o", "明るい一曲です。", "いいですね。"), readings: [{ text: "大船渡", reading: "オオフナト" }] }), byId([far]), byId([psy]));
    expect(seg!.lines.find((l) => l.type === "dj" && l.text.includes("お住まい"))).toEqual({ type: "dj", text: "大船渡にお住まいの、そらさんからのお便りです。", spoken: "オオフナトにお住まいの、そらさんからのお便りです。", fixed: true });
    expect(verifyEpisode([seg!], byId([far]), listener(), byId([psy])).details).toEqual([]);
  });

  it("composes lines that pass the verifier", () => {
    const segs = composeEpisode(plan, unitsOf(u), byId([fan]), byId([psy]));
    expect(verifyEpisode(segs, byId([fan]), listener(), byId([psy])).details).toEqual([]);
  });
});
