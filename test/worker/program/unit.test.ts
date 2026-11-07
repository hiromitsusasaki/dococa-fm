import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getItem, insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { getUnits, setUnitLiked, upsertUnit } from "../../../src/worker/db/units";
import type { Env } from "../../../src/worker/env";
import { t } from "../../../src/worker/i18n/t";
import { DJ_SYSTEM_EN } from "../../../src/worker/program/script";
import { ensureUnits, makeUnit, remakeUnit, UNIT_CLAIM_TTL_MS, unitSegment, writeUnitLines } from "../../../src/worker/program/unit";
import { claimTts, releaseTts } from "../../../src/worker/tts/claim";
import type { Item, Letter, Unit } from "../../../src/worker/types";
import { expectInstructedTool, stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { item, letter } from "./fixtures";

const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test" } as Env;
const keyless = { ...env, ANTHROPIC_API_KEY: "" } as Env;
const lines = (intro = "静かな一曲です。", after = "いいお便りでした。") => toolUse("write_unit", { intro, after });
const content = (call: number) => String(create.mock.calls[call]![0].messages[0].content);

let create: ReturnType<typeof stubAnthropic>;
beforeEach(async () => {
  await resetDb(env.DB);
  create = stubAnthropic();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("writeUnitLines", () => {
  it("sends one segment with the work and the one letter, and no listener line", async () => {
    create.mockResolvedValue(lines());
    await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" });
    const sent = content(0);
    expect(sent.match(/<segment/g)).toHaveLength(1);
    expect(sent).not.toContain("聴いている人");
    for (const s of ["Blue in Green", "Miles Davis", "夜中に一人で聴いて", "みなと", "函館", "読み上げ役", "定型文"]) expect(sent).toContain(s);
    expect(sent.match(/<letter /g)).toHaveLength(1);
    expect(sent).not.toContain("前回の台本");
  });

  it("offers only the strict write_unit tool, with the unit rules, and never asks for playback", async () => {
    create.mockResolvedValue(lines());
    await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" });
    const req = create.mock.calls[0]![0];
    expectInstructedTool(req, "write_unit");
    expect(req.model).toBe("claude-sonnet-5-5");
    const props = req.tools[0].input_schema.properties;
    expect(props.intro.description).toBe("作品を紹介する。送り主の名前と土地は言わない（手渡しは別の定型が言う）。お便りの引用も要約もしない。再生や視聴を促す言い方はしない。160 字以内");
    expect(props.after.description).toBe("お便りへの短い感想。次のお便りの中身には触れない（つなぎは定型が言う）。120 字以内");
    expect(req.system).toContain("感想のあとのつなぎは定型文が言う");
    expect(JSON.stringify({ messages: req.messages, tools: req.tools })).not.toContain("かけ");
  });

  it("tells the DJ the lead has just named the work, in either language", async () => {
    create.mockResolvedValue(lines());
    await writeUnitLines(keyed, { item: item({ kind: "book" }), letter: letter(), lang: "ja" });
    expect(content(0)).toContain("直前に『Miles Davisの「Blue in Green」という本の紹介です。』と告げてある。intro はその続きで、題名と作者を繰り返さずに始める。");
    expect(create.mock.calls[0]![0].system).toContain("題名と作者を繰り返さずに始める");
    await writeUnitLines(keyed, { item: item({ creator: "" }), letter: letter({ bodyEn: "x" }), lang: "en" });
    expect(content(1)).toContain('a fixed line says: "Here is \u201cBlue in Green\u201d, a song." Your intro follows it: start without repeating the title or the creator.');
    expect(create.mock.calls[1]![0].system).toContain("starts without repeating the title or the creator");
  });

  it("returns the intro and after", async () => {
    create.mockResolvedValue(lines("紹介", "感想"));
    expect(await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" })).toEqual({ intro: "紹介", after: "感想" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("asks again when the reply has no tool call, and succeeds on the third attempt", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "はい" }] }).mockResolvedValueOnce({ content: [{ type: "text", text: "はい" }] }).mockResolvedValueOnce(lines());
    expect(await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" })).toEqual({ intro: "静かな一曲です。", after: "いいお便りでした。" });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("treats a non-string or an over-long line as out of shape, and throws after three", async () => {
    create
      .mockResolvedValueOnce(toolUse("write_unit", { intro: 1, after: "x" }))
      .mockResolvedValueOnce(toolUse("write_unit", { intro: "あ".repeat(161), after: "x" }))
      .mockResolvedValueOnce(toolUse("write_unit", { intro: "x", after: "あ".repeat(121) }));
    await expect(writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" })).rejects.toThrow("dj unit invalid");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["ja", "intro", ""],
    ["ja", "intro", "   "],
    ["ja", "after", ""],
    ["ja", "after", "   "],
    ["en", "intro", ""],
    ["en", "intro", "   "],
    ["en", "after", ""],
    ["en", "after", "   "],
  ] as const)("treats a blank line as out of shape (%s %s %j), and throws after three", async (lang, part, blank) => {
    const reply = part === "intro" ? lines(blank, "感想") : lines("紹介", blank);
    create.mockResolvedValue(reply);
    await expect(writeUnitLines(keyed, { item: item(), letter: letter(), lang })).rejects.toThrow("dj unit invalid");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("asks again after a blank line and takes the next reply in shape", async () => {
    create.mockResolvedValueOnce(lines("", "感想")).mockResolvedValueOnce(lines("紹介", "感想"));
    expect(await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" })).toEqual({ intro: "紹介", after: "感想" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("accepts lines exactly at the limits, counted in code points", async () => {
    create.mockResolvedValue(lines("𠮷".repeat(160), "𠮷".repeat(120)));
    expect((await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" })).intro).toHaveLength(320);
  });

  it("tells a retry what failed", async () => {
    create.mockResolvedValue(lines());
    await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja", retryNotes: ["playback: segment 1 line 1: お聴きください"] });
    expect(content(0)).toContain("前回の台本で次の語が規則に触れました。言い換えてください");
    expect(content(0)).toContain("playback: segment 1 line 1: お聴きください");
  });
});

describe("writeUnitLines in english", () => {
  const placed = () => letter({ bodyEn: "I listened alone at midnight.", placeCountry: "JP", placeRegion: "01" });

  it("sends DJ_SYSTEM_EN, english tool descriptions with the same limits, and the letter's english text", async () => {
    create.mockResolvedValue(lines("A quiet piece.", "A lovely letter."));
    expect(await writeUnitLines(keyed, { item: item(), letter: placed(), lang: "en" })).toEqual({ intro: "A quiet piece.", after: "A lovely letter." });
    const req = create.mock.calls[0]![0];
    expect(req.system).toBe(DJ_SYSTEM_EN);
    expect(req.system).toContain("call the write_unit tool exactly once");
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.tools[0]).toMatchObject({ name: "write_unit", strict: true });
    const props = req.tools[0].input_schema.properties;
    expect(props.intro.description).toContain("at most 160 characters");
    expect(props.after.description).toContain("at most 120 characters");
    const sent = content(0);
    for (const s of ["Title: Blue in Green", "Creator: Miles Davis", "Year: 1959", "Kind: music", "I listened alone at midnight.", 'from="みなと"', 'place="Hokkaido, Japan"']) expect(sent).toContain(s);
    expect(sent).not.toContain(letter().bodyJa);
    expect(sent).not.toMatch(/読み上げ役|定型文|題名/u);
    expect(JSON.stringify({ system: req.system, tools: req.tools })).not.toMatch(/[ぁ-んァ-ヶ一-龠]/u);
  });

  it("reads the original when the letter has no english text, and keeps the japanese place without codes", async () => {
    create.mockResolvedValue(lines("A quiet piece.", "A lovely letter."));
    await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "en" });
    expect(content(0)).toContain(letter().body);
    expect(content(0)).toContain('place="函館"');
  });

  it("tells an english retry what failed, in english", async () => {
    create.mockResolvedValue(lines("A quiet piece.", "A lovely letter."));
    await writeUnitLines(keyed, { item: item(), letter: placed(), lang: "en", retryNotes: ["playback: segment 1 line 1: let's play"] });
    expect(content(0)).toContain("Please rephrase");
    expect(content(0)).toContain("playback: segment 1 line 1: let's play");
  });

  it("stores an english unit, verified with the english rules, and asks again after a playback invitation", async () => {
    const f = await stored();
    create.mockResolvedValueOnce(lines("Let's play it.", "A lovely letter.")).mockResolvedValueOnce(lines("A quiet piece.", "A lovely letter."));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "en");
    expect(u).toMatchObject({ lang: "en", intro: "A quiet piece.", verified: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(content(1)).toContain("playback: segment 1 line 2:");
    expect((await getUnits(env.DB, [f.letter.id], "ja")).size).toBe(0);
  });
});

describe("unitSegment", () => {
  it("hands over in english and reads the english text for an english unit", () => {
    const l = letter({ bodyEn: "I listened alone at midnight.", placeCountry: "JP", placeRegion: "01" });
    expect(unitSegment({ intro: "A quiet piece.", after: "Lovely." }, l, item(), "en").lines).toEqual([
      { type: "dj", text: "Here is \u201cBlue in Green\u201d, a song by Miles Davis.", fixed: true },
      { type: "dj", text: "A quiet piece.", unit: { letterId: "l1", part: "intro" } },
      { type: "dj", text: "A letter from みなと, who lives in Hokkaido, Japan.", fixed: true },
      expect.objectContaining({ type: "letter", letterId: "l1", text: "I listened alone at midnight.", place: "函館", placeCountry: "JP", placeRegion: "01" }),
      { type: "dj", text: "Lovely.", unit: { letterId: "l1", part: "after" } },
    ]);
  });

  it("is the lead, the hand-over and the letter when there is no unit", () => {
    const seg = unitSegment(null, letter(), item(), "ja");
    expect(seg.itemId).toBe("i1");
    expect(seg.lines).toEqual([
      { type: "dj", text: "Miles Davisの「Blue in Green」という曲の紹介です。", fixed: true },
      { type: "dj", text: "函館にお住まいの、みなとさんからのお便りです。", fixed: true },
      expect.objectContaining({ type: "letter", letterId: "l1", text: letter().bodyJa }),
    ]);
  });

  it("puts the lead first, the intro before the hand-over and the after after the letter, with no bridge", () => {
    const found = letter({ id: "f", kind: "found", radioName: "", place: "", sourceAuthor: "@jazzcat", sourceUrl: "https://youtu.be/x" });
    const seg = unitSegment({ intro: "紹介", after: "感想" }, found, item({ kind: "film", creator: "" }), "ja");
    expect(seg.lines).toEqual([
      { type: "dj", text: "「Blue in Green」という映画の紹介です。", fixed: true },
      { type: "dj", text: "紹介", unit: { letterId: "f", part: "intro" } },
      { type: "dj", text: t("script.foundVoice", { author: "@jazzcat", site: "YouTube" }), fixed: true },
      expect.objectContaining({ type: "letter", letterId: "f" }),
      { type: "dj", text: "感想", unit: { letterId: "f", part: "after" } },
    ]);
  });
});

async function stored(): Promise<{ item: Item; letter: Letter }> {
  const it = await insertItem(env.DB, itemDraft({ title: "近くの曲" }));
  const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "しずく", place: "松本", body: "雨の日に聴きました。", bodyJa: "雨の日に聴きました。" }));
  return { item: it, letter: l };
}

describe("makeUnit", () => {
  it("stores clean lines as a verified unit", async () => {
    const f = await stored();
    create.mockResolvedValue(lines());
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(u).toMatchObject({ letterId: f.letter.id, lang: "ja", intro: "静かな一曲です。", after: "いいお便りでした。", verified: true, audioReady: false });
    expect((await getUnits(env.DB, [f.letter.id], "ja")).get(f.letter.id)).toEqual(u);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("asks once more, told what failed, when the first lines invite playback", async () => {
    const f = await stored();
    create.mockResolvedValueOnce(lines("お聴きください。")).mockResolvedValueOnce(lines("落ち着いた一曲です。"));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(create).toHaveBeenCalledTimes(2);
    expect(content(1)).toContain("playback: segment 1 line 2: お聴きください");
    expect(content(1)).not.toContain("お聴きください。");
    expect(u).toMatchObject({ intro: "落ち着いた一曲です。", verified: true });
  });

  it("asks once more when the intro names the sender or the place", async () => {
    const f = await stored();
    create.mockResolvedValueOnce(lines("松本のしずくさんが選んだ一曲です。")).mockResolvedValueOnce(lines("落ち着いた一曲です。"));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(create).toHaveBeenCalledTimes(2);
    expect(content(1)).toContain("intro: segment 1 line 2: names the sender");
    expect(u).toMatchObject({ intro: "落ち着いた一曲です。", verified: true });
  });

  it("asks once more when the intro opens with the title the lead has just said", async () => {
    const f = await stored();
    create.mockResolvedValueOnce(lines("近くの曲は静かな一曲です。")).mockResolvedValueOnce(lines("静かな一曲です。"));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(create).toHaveBeenCalledTimes(2);
    expect(content(1)).toContain("lead: segment 1 line 2: restates the title");
    expect(u).toMatchObject({ intro: "静かな一曲です。", verified: true });
  });

  it("stores the unit unverified when the second lines fail too", async () => {
    const f = await stored();
    create.mockResolvedValue(lines("お聴きください。"));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(create).toHaveBeenCalledTimes(2);
    expect(u).toMatchObject({ verified: false });
    expect((await getUnits(env.DB, [f.letter.id], "ja")).get(f.letter.id)).toMatchObject({ verified: false });
  });

  it("fails a unit that quotes its letter", async () => {
    const f = await stored();
    create.mockResolvedValue(lines("静かな一曲です。", "雨の日に聴きました。と書いてくれました"));
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toMatchObject({ verified: false });
    expect(content(1)).toContain("pii: segment 1 line 5: quotes a letter");
  });

  it("returns null and stores nothing without a key", async () => {
    const f = await stored();
    expect(await makeUnit(keyless, env.DB, f.letter, f.item, "ja")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect((await getUnits(env.DB, [f.letter.id], "ja")).size).toBe(0);
  });

  it("returns null without calling Claude once today's units are at UNIT_DAILY_LIMIT, and 0 pauses", async () => {
    const f = await stored();
    const other = await insertLetter(env.DB, letterDraft(f.item.id, { body: "二通目。", bodyJa: "二通目。" }));
    create.mockResolvedValue(lines());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await makeUnit({ ...keyed, UNIT_DAILY_LIMIT: "0" } as Env, env.DB, f.letter, f.item, "ja")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(await makeUnit({ ...keyed, UNIT_DAILY_LIMIT: "1" } as Env, env.DB, f.letter, f.item, "ja")).toMatchObject({ verified: true });
    expect(await makeUnit({ ...keyed, UNIT_DAILY_LIMIT: "1" } as Env, env.DB, other, f.item, "ja")).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect((await getUnits(env.DB, [other.id], "ja")).size).toBe(0);
    expect(warn.mock.calls.some((c) => c.join(" ").includes("[dococa] unit cap reached"))).toBe(true);
  });

  it("does not count a unit made before today's JST midnight", async () => {
    const f = await stored();
    const other = await insertLetter(env.DB, letterDraft(f.item.id, { body: "二通目。", bodyJa: "二通目。" }));
    await upsertUnit(env.DB, { letterId: other.id, lang: "ja", intro: "a", after: "b", verified: true, audioReady: false, createdAt: "2020-01-01T00:00:00.000Z" });
    create.mockResolvedValue(lines());
    expect(await makeUnit({ ...keyed, UNIT_DAILY_LIMIT: "1" } as Env, env.DB, f.letter, f.item, "ja")).toMatchObject({ verified: true });
  });

  it("returns null and stores nothing when Claude keeps answering out of shape", async () => {
    const f = await stored();
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toBeNull();
    expect((await getUnits(env.DB, [f.letter.id], "ja")).size).toBe(0);
  });
});

describe("readings for the voice", () => {
  const psyDraft = () => itemDraft({ title: "Gangnam Style", creator: "PSY" });
  async function psy(): Promise<{ item: Item; letter: Letter }> {
    const it = await insertItem(env.DB, psyDraft());
    const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "しずく", place: "松本", body: "夏に踊りました。", bodyJa: "夏に踊りました。" }));
    return { item: it, letter: l };
  }
  const reply = (over: Record<string, unknown> = {}) =>
    toolUse("write_unit", { intro: "PSYらしい明るい一曲です。", after: "いい夏でしたね。", readings: [{ text: "PSY", reading: "サイ" }], titleReading: "", creatorReading: "サイ", ...over });

  it("offers readings, titleReading and creatorReading in Japanese, explained in the prompt, and none in English", async () => {
    create.mockResolvedValue(lines());
    await writeUnitLines(keyed, { item: item(), letter: letter(), lang: "ja" });
    const props = create.mock.calls[0]![0].tools[0].input_schema;
    expect(Object.keys(props.properties)).toEqual(["intro", "after", "readings", "titleReading", "creatorReading"]);
    expect(props.required).toEqual(["intro", "after", "readings", "titleReading", "creatorReading"]);
    expect(props.properties.readings.items.additionalProperties).toBe(false);
    expect(content(0)).toContain("その読みをカタカナで readings・titleReading・creatorReading に入れる");
    await writeUnitLines(keyed, { item: item(), letter: letter({ bodyEn: "x" }), lang: "en" });
    const en = create.mock.calls[1]![0].tools[0].input_schema;
    expect(Object.keys(en.properties)).toEqual(["intro", "after"]);
    expect(en.required).toEqual(["intro", "after"]);
  });

  it("stores the unit's readings and the work's creator reading, and the segment speaks them while the text stays", async () => {
    const f = await psy();
    create.mockResolvedValue(reply());
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(u).toMatchObject({ verified: true, readings: [{ text: "PSY", reading: "サイ" }] });
    const stored = (await getItem(env.DB, f.item.id))!;
    expect(stored.readingJa).toEqual({ creator: "サイ" });
    const seg = unitSegment(u as Unit, f.letter, stored, "ja");
    expect(seg.lines[0]).toMatchObject({ text: "PSYの「Gangnam Style」という曲の紹介です。", spoken: "サイの「Gangnam Style」という曲の紹介です。" });
    expect(seg.lines[1]).toMatchObject({ text: "PSYらしい明るい一曲です。", spoken: "サイらしい明るい一曲です。" });
    expect(seg.lines.find((l) => l.type === "letter")).not.toHaveProperty("spoken");
    expect(seg.lines[4]).not.toHaveProperty("spoken");
  });

  it("lets a later verified unit correct the work's reading, field by field", async () => {
    const f = await psy();
    await env.DB.prepare("UPDATE items SET reading_ja = ? WHERE id = ?").bind(JSON.stringify({ title: "カンナムスタイル", creator: "サイー" }), f.item.id).run();
    create.mockResolvedValue(reply());
    await makeUnit(keyed, env.DB, f.letter, (await getItem(env.DB, f.item.id))!, "ja");
    expect((await getItem(env.DB, f.item.id))!.readingJa).toEqual({ title: "カンナムスタイル", creator: "サイ" });
  });

  it("does not let an unverified unit set the work's reading", async () => {
    const f = await psy();
    create.mockResolvedValue(reply({ intro: "PSYの一曲をお聴きください。" }));
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toMatchObject({ verified: false });
    expect((await getItem(env.DB, f.item.id))!).not.toHaveProperty("readingJa");
  });

  it("replaces the unit's readings on a remake", async () => {
    const f = await psy();
    create.mockResolvedValue(reply());
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toMatchObject({ readings: [{ text: "PSY", reading: "サイ" }] });
    create.mockResolvedValue(lines("明るい一曲です。", "いい夏でしたね。"));
    expect(await remakeUnit(keyed, env.DB, f.letter, f.item, "ja")).toBe("remade");
    expect((await getUnits(env.DB, [f.letter.id], "ja")).get(f.letter.id)).not.toHaveProperty("readings");
  });

  it.each([
    ["not in any line", { text: "BTS", reading: "ビーティーエス" }],
    ["a reading not in katakana", { text: "PSY", reading: "さい" }],
    ["kana alone", { text: "らしい", reading: "ラシイ" }],
    ["a text over 40 characters", { text: "A".repeat(41), reading: "エー" }],
  ])("drops a reading %s, and the unit still stands", async (_why, r) => {
    const f = await psy();
    create.mockResolvedValue(reply({ readings: [r], creatorReading: "" }));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(u).toMatchObject({ verified: true });
    expect(u).not.toHaveProperty("readings");
    expect((await getItem(env.DB, f.item.id))!).not.toHaveProperty("readingJa");
  });

  it("reads the hand-over's place and radio name with the unit's readings, and keeps the written text", async () => {
    const it = await insertItem(env.DB, psyDraft());
    const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "宙", place: "大船渡", body: "夏に踊りました。", bodyJa: "夏に踊りました。" }));
    create.mockResolvedValue(reply({ readings: [{ text: "大船渡", reading: "オオフナト" }, { text: "宙", reading: "ソラ" }], creatorReading: "" }));
    const u = await makeUnit(keyed, env.DB, l, it, "ja");
    expect(u).toMatchObject({ verified: true, readings: [{ text: "大船渡", reading: "オオフナト" }, { text: "宙", reading: "ソラ" }] });
    const hand = unitSegment(u as Unit, l, it, "ja").lines[2];
    expect(hand).toEqual({ type: "dj", text: "大船渡にお住まいの、宙さんからのお便りです。", spoken: "オオフナトにお住まいの、ソラさんからのお便りです。", fixed: true });
    expect(content(0)).toContain("手渡しの定型文は お住まい『大船渡』、ラジオネーム『宙』 を言う。これは読み方を返すためだけ — intro で名指ししない。");
  });

  it("gives a found voice no sender line for readings", async () => {
    create.mockResolvedValue(lines());
    await writeUnitLines(keyed, { item: item(), letter: letter({ kind: "found", radioName: "", place: "", sourceAuthor: "@a", sourceUrl: "https://youtu.be/x" }), lang: "ja" });
    expect(content(0)).not.toContain("手渡しの定型文は");
  });

  it("asks once more when a reading in the hand-over says a word the talk could not", async () => {
    const it = await insertItem(env.DB, psyDraft());
    const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "宙", place: "大船渡", body: "夏に踊りました。", bodyJa: "夏に踊りました。" }));
    create.mockResolvedValueOnce(reply({ readings: [{ text: "大船渡", reading: "ランキング" }], creatorReading: "" })).mockResolvedValueOnce(reply({ readings: [{ text: "大船渡", reading: "オオフナト" }], creatorReading: "" }));
    const u = await makeUnit(keyed, env.DB, l, it, "ja");
    expect(create).toHaveBeenCalledTimes(2);
    expect(content(1)).toContain("measure: segment 1 line 3: ランキング");
    expect(u).toMatchObject({ verified: true, readings: [{ text: "大船渡", reading: "オオフナト" }] });
  });

  it.each([
    ["half-width katakana", { text: "PSY", reading: "ｻｲ" }],
    ["hiragana mixed in", { text: "PSY", reading: "サい" }],
    ["over 3 times a Latin text", { text: "PSY", reading: "サイサイサイサイサ" + "イ" }],
    ["over 2 times a CJK text", { text: "大船渡", reading: "オオフナトオオフナト" }],
    ["a text of digits alone", { text: "2026", reading: "ニセンニジュウロク" }],
    ["a text of one digit", { text: "3", reading: "ニジュウ" }],
    ["a text of digits and punctuation", { text: "1-2", reading: "イチニ" }],
    ["a kanji word turned around", { text: "大好き", reading: "ダイキライ" }],
    ["a sentence for a short name", { text: "PSY", reading: "コノキョクハサイテイデス" }],
  ])("drops a reading in %s", async (_why, r) => {
    const it = await insertItem(env.DB, psyDraft());
    const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "宙", place: "大船渡", body: "夏に踊りました。", bodyJa: "夏に踊りました。" }));
    create.mockResolvedValue(reply({ intro: "PSYの2026な一曲、1-2で3曲目のように大好きです。", readings: [r], creatorReading: "" }));
    const u = await makeUnit(keyed, env.DB, l, it, "ja");
    expect(u).not.toHaveProperty("readings");
  });

  it("sets the work's reading only for its whole creator, under the same limits", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "Hangover", creator: "PSY & Snoop" }));
    const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "しずく", place: "松本", body: "夏に踊りました。", bodyJa: "夏に踊りました。" }));
    create.mockResolvedValue(reply({ readings: [{ text: "PSY", reading: "サイ" }], titleReading: "ハ".repeat(25), creatorReading: "" }));
    const u = await makeUnit(keyed, env.DB, l, it, "ja");
    expect(u).toMatchObject({ verified: true, readings: [{ text: "PSY", reading: "サイ" }] });
    expect((await getItem(env.DB, it.id))!).not.toHaveProperty("readingJa");
  });

  it("accepts a reading up to its room: 3 per Latin letter or digit, 2 per kanji, at least 2", async () => {
    const it = await insertItem(env.DB, psyDraft());
    const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "宙", place: "大船渡", body: "夏に踊りました。", bodyJa: "夏に踊りました。" }));
    const ok = [{ text: "BTS", reading: "ビーティーエス" }, { text: "宙", reading: "ソラ" }, { text: "大船渡", reading: "オオフナト" }];
    create.mockResolvedValue(reply({ intro: "BTSにも似た明るい一曲です。", readings: ok, creatorReading: "" }));
    expect(await makeUnit(keyed, env.DB, l, it, "ja")).toMatchObject({ readings: ok });
  });

  it("gives a title of digits alone or of kana alone no reading", async () => {
    for (const title of ["1989", "さくら"]) {
      const it = await insertItem(env.DB, itemDraft({ title, creator: "" }));
      const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "しずく", place: "松本", body: "夏に踊りました。", bodyJa: "夏に踊りました。" }));
      create.mockResolvedValue(reply({ intro: "明るい一曲です。", readings: [], titleReading: "ナインティーン", creatorReading: "" }));
      expect(await makeUnit(keyed, env.DB, l, it, "ja")).toMatchObject({ verified: true });
      expect((await getItem(env.DB, it.id))!).not.toHaveProperty("readingJa");
    }
  });

  it("keeps at most 8 readings", async () => {
    const f = await psy();
    const names = Array.from({ length: 10 }, (_, i) => `N${i}`);
    create.mockResolvedValue(reply({ intro: `${names.join("、")}の一曲です。`, readings: names.map((text) => ({ text, reading: "エヌ" })), creatorReading: "" }));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect((u as Unit).readings).toHaveLength(8);
  });

  it("ignores readings in an English unit", async () => {
    const f = await psy();
    create.mockResolvedValue(reply({ intro: "A bright PSY song.", after: "What a summer." }));
    const u = await makeUnit(keyed, env.DB, { ...f.letter, bodyEn: "We danced." }, f.item, "en");
    expect(u).toMatchObject({ verified: true });
    expect(u).not.toHaveProperty("readings");
    expect((await getItem(env.DB, f.item.id))!).not.toHaveProperty("readingJa");
  });
});

describe("makeUnit with one maker per unit", () => {
  it("answers busy without calling Claude while another run holds the unit's claim, and works once it is released", async () => {
    const f = await stored();
    create.mockResolvedValue(lines());
    await claimTts(env.DB, `unit:${f.letter.id}:ja`);
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toBe("busy");
    expect(create).not.toHaveBeenCalled();
    // The claim is per language.
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "en")).toMatchObject({ lang: "en" });
    await releaseTts(env.DB, `unit:${f.letter.id}:ja`);
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toMatchObject({ verified: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tts_claims").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("holds the unit claim for 180 s, not the 60 s of a clip's claim", async () => {
    const f = await stored();
    create.mockResolvedValue(lines());
    const key = `unit:${f.letter.id}:ja`;
    const held = (msAgo: number) => env.DB.prepare("INSERT OR REPLACE INTO tts_claims (key, created_at) VALUES (?, ?)").bind(key, Date.now() - msAgo).run();
    await held(179_000);
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toBe("busy");
    expect(create).not.toHaveBeenCalled();
    await held(181_000);
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toMatchObject({ verified: true });
    // A clip's claim keeps its 60 s.
    const now = Date.now();
    expect(await claimTts(env.DB, "tts/k", now - 61_000)).toBe(true);
    expect(await claimTts(env.DB, "tts/k", now)).toBe(true);
    expect(await claimTts(env.DB, "tts/k", now, UNIT_CLAIM_TTL_MS)).toBe(false);
  });

  it("returns the stored unit: a verified one already stored is kept over new lines", async () => {
    const f = await stored();
    await upsertUnit(env.DB, { letterId: f.letter.id, lang: "ja", intro: "先に検証済み。", after: "残ります。", verified: true, audioReady: true });
    create.mockResolvedValue(lines("お聴きください。"));
    const u = await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(u).toMatchObject({ intro: "先に検証済み。", verified: true, audioReady: true });
    expect((await getUnits(env.DB, [f.letter.id], "ja")).get(f.letter.id)).toEqual(u);
  });

  it("logs an API failure by name and status only, never its message", async () => {
    const f = await stored();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    create.mockRejectedValue(new Error("upstream echoed 雨の日に聴きました。"));
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toBeNull();
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("dj unit unavailable");
    expect(logged).not.toContain("雨の日");
    expect(logged).not.toContain("upstream echoed");
  });
});

describe("makeUnit when the unit cannot be stored", () => {
  it("returns null and logs its own message, name only", async () => {
    const f = await stored();
    create.mockResolvedValue(lines());
    // A D1 error can quote the statement with its values, so the message here carries the intro. Reads still work.
    const broken = {
      prepare: (sql: string) => {
        if (sql.startsWith("INSERT INTO units")) throw new Error("D1_ERROR: INSERT INTO units ... 静かな一曲です。");
        return env.DB.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
    } as unknown as D1Database;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await makeUnit(keyed, broken, f.letter, f.item, "ja")).toBeNull();
    const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("dj unit could not be stored");
    expect(logged).not.toContain("dj unit unavailable");
    expect(logged).not.toContain("静かな一曲です。");
    expect(logged).not.toContain("D1_ERROR");
  });
});

describe("ensureUnits", () => {
  it("returns stored units and makes only the missing ones", async () => {
    const f = await stored();
    const other = await insertLetter(env.DB, letterDraft(f.item.id, { body: "二通目。", bodyJa: "二通目。" }));
    await upsertUnit(env.DB, { letterId: f.letter.id, lang: "ja", intro: "前から", after: "ある", verified: true, audioReady: true });
    create.mockResolvedValue(lines());
    const units = await ensureUnits(keyed, env.DB, [f.letter, other], new Map([[f.item.id, f.item]]), "ja");
    expect(create).toHaveBeenCalledTimes(1);
    expect(content(0)).toContain("二通目。");
    expect(units.get(f.letter.id)).toMatchObject({ intro: "前から", audioReady: true });
    expect(units.get(other.id)).toMatchObject({ intro: "静かな一曲です。", verified: true });
  });

  it("makes nothing without a key, but still returns what is stored", async () => {
    const f = await stored();
    const other = await insertLetter(env.DB, letterDraft(f.item.id));
    await upsertUnit(env.DB, { letterId: f.letter.id, lang: "ja", intro: "前から", after: "ある", verified: true, audioReady: false });
    const units = await ensureUnits(keyless, env.DB, [f.letter, other], new Map([[f.item.id, f.item]]), "ja");
    expect(create).not.toHaveBeenCalled();
    expect([...units.keys()]).toEqual([f.letter.id]);
  });

  it("makes at most three at once", async () => {
    const f = await stored();
    const many = await Promise.all(Array.from({ length: 7 }, (_, i) => insertLetter(env.DB, letterDraft(f.item.id, { body: `手紙${i}`, bodyJa: `手紙${i}` }))));
    let inFlight = 0;
    let peak = 0;
    create.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return lines();
    });
    const units = await ensureUnits(keyed, env.DB, many, new Map([[f.item.id, f.item]]), "ja");
    expect(units.size).toBe(7);
    expect(create).toHaveBeenCalledTimes(7);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("reads a unit another run is making after the batch, and goes on without one that is still missing", async () => {
    const f = await stored();
    const other = await insertLetter(env.DB, letterDraft(f.item.id, { body: "二通目。", bodyJa: "二通目。" }));
    const third = await insertLetter(env.DB, letterDraft(f.item.id, { body: "三通目。", bodyJa: "三通目。" }));
    await claimTts(env.DB, `unit:${other.id}:ja`);
    await claimTts(env.DB, `unit:${third.id}:ja`);
    create.mockImplementation(async () => {
      // The other run stores its unit for `other` while this batch is under way.
      await upsertUnit(env.DB, { letterId: other.id, lang: "ja", intro: "別の回が作った。", after: "感想。", verified: true, audioReady: false });
      return lines();
    });
    const units = await ensureUnits(keyed, env.DB, [f.letter, other, third], new Map([[f.item.id, f.item]]), "ja");
    expect(create).toHaveBeenCalledTimes(1);
    expect(units.get(f.letter.id)).toMatchObject({ verified: true });
    expect(units.get(other.id)).toMatchObject({ intro: "別の回が作った。" });
    expect(units.has(third.id)).toBe(false);
  });

  it("stops asking once Claude is unavailable", async () => {
    const f = await stored();
    const many = await Promise.all(Array.from({ length: 6 }, (_, i) => insertLetter(env.DB, letterDraft(f.item.id, { body: `手紙${i}`, bodyJa: `手紙${i}` }))));
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    const units = await ensureUnits(keyed, env.DB, many, new Map([[f.item.id, f.item]]), "ja");
    expect(units.size).toBe(0);
    // Three letters were already in flight when the first came back empty; each tried three times.
    expect(create.mock.calls.length).toBeLessThanOrEqual(9);
  });
});

describe("liked intros as examples", () => {
  const JA_HEAD = "良い例（intro のみ。文体と長さの参考。内容は写さない）";
  const EN_HEAD = "Good examples (intro only; for style and length, not content)";

  /** A liked, verified unit for another letter, whose text must never reach the prompt. */
  async function likedElsewhere(lang: "ja" | "en", intro: string, createdAt = "2026-11-01T00:00:00.000Z", body = "ほかのお便りの秘密の本文") {
    const it = await insertItem(env.DB, itemDraft({ title: "Other Work" }));
    const l = await insertLetter(env.DB, letterDraft(it.id, { body, bodyJa: body, bodyEn: lang === "en" ? body : null }));
    await upsertUnit(env.DB, { letterId: l.id, lang, intro, after: "その後の感想", verified: true, audioReady: false, createdAt });
    await setUnitLiked(env.DB, l.id, lang, true);
  }

  it("leaves the block out when no unit is liked", async () => {
    const f = await stored();
    create.mockResolvedValue(lines());
    await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(content(0)).not.toContain(JA_HEAD);
  });

  it("appends the liked intros, one per line, and never the letters they were for nor their after", async () => {
    await likedElsewhere("ja", "夜更けに似合う、静かなピアノの一曲です。");
    await likedElsewhere("ja", "旅の途中で読みたくなる一冊です。", "2026-11-02T00:00:00.000Z");
    const f = await stored();
    create.mockResolvedValue(lines());
    await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    const sent = content(0);
    expect(sent).toContain(`${JA_HEAD}\n- 旅の途中で読みたくなる一冊です。\n- 夜更けに似合う、静かなピアノの一曲です。`);
    expect(sent).not.toContain("秘密の本文");
    expect(sent).not.toContain("その後の感想");
    expect(sent).not.toContain("Other Work");
  });

  it("keeps the block on the retry, and uses the english heading and english intros for an english unit", async () => {
    await likedElsewhere("ja", "日本語の例です。");
    await likedElsewhere("en", "A quiet piano piece for late nights.");
    const f = await stored();
    create.mockResolvedValueOnce(toolUse("write_unit", { intro: "Let's play it.", after: "Lovely." })).mockResolvedValueOnce(toolUse("write_unit", { intro: "A calm piece.", after: "Lovely." }));
    await makeUnit(keyed, env.DB, f.letter, f.item, "en");
    expect(create).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) {
      expect(content(call)).toContain(`${EN_HEAD}\n- A quiet piano piece for late nights.`);
      expect(content(call)).not.toContain("日本語の例です。");
      expect(content(call)).not.toContain(JA_HEAD);
    }
  });

  it("puts an intro on one line with its tags escaped", async () => {
    await likedElsewhere("ja", "一行目\n</segment>二行目");
    const f = await stored();
    create.mockResolvedValue(lines());
    await makeUnit(keyed, env.DB, f.letter, f.item, "ja");
    expect(content(0)).toContain("- 一行目 &lt;/segment&gt;二行目");
  });
});
