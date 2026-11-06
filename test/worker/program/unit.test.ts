import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { getUnits, upsertUnit } from "../../../src/worker/db/units";
import type { Env } from "../../../src/worker/env";
import { t } from "../../../src/worker/i18n/t";
import { ensureUnits, makeUnit, unitSegment, writeUnitLines } from "../../../src/worker/program/unit";
import type { Item, Letter } from "../../../src/worker/types";
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

describe("unitSegment", () => {
  it("is the hand-over and the letter when there is no unit", () => {
    const seg = unitSegment(null, letter(), item(), "ja");
    expect(seg.itemId).toBe("i1");
    expect(seg.lines).toEqual([
      { type: "dj", text: "みなとさん（函館）からのお便りです。", fixed: true },
      expect.objectContaining({ type: "letter", letterId: "l1", text: letter().bodyJa }),
    ]);
  });

  it("puts the intro before the hand-over and the after after the letter, with no bridge", () => {
    const found = letter({ id: "f", kind: "found", radioName: "", place: "", sourceAuthor: "@jazzcat", sourceUrl: "https://youtu.be/x" });
    const seg = unitSegment({ intro: "紹介", after: "感想" }, found, item(), "ja");
    expect(seg.lines).toEqual([
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
    expect(content(1)).toContain("playback: segment 1 line 1: お聴きください");
    expect(content(1)).not.toContain("お聴きください。");
    expect(u).toMatchObject({ intro: "落ち着いた一曲です。", verified: true });
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
    expect(content(1)).toContain("pii: segment 1 line 4: quotes a letter");
  });

  it("returns null and stores nothing without a key", async () => {
    const f = await stored();
    expect(await makeUnit(keyless, env.DB, f.letter, f.item, "ja")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect((await getUnits(env.DB, [f.letter.id], "ja")).size).toBe(0);
  });

  it("returns null and stores nothing when Claude keeps answering out of shape", async () => {
    const f = await stored();
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    expect(await makeUnit(keyed, env.DB, f.letter, f.item, "ja")).toBeNull();
    expect((await getUnits(env.DB, [f.letter.id], "ja")).size).toBe(0);
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
