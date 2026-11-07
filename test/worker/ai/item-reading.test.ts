import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureItemReading, ensureItemReadings } from "../../../src/worker/ai/item-reading";
import { getItem, insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { upsertUnit } from "../../../src/worker/db/units";
import type { Env } from "../../../src/worker/env";
import { expectInstructedTool, stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test" } as Env;
const keyless = { ...env, ANTHROPIC_API_KEY: "" } as Env;
const named = (input: unknown) => toolUse("name_readings", input);

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

describe("ensureItemReading", () => {
  it("asks once with the work's title, creator, year and kind only, never a letter, and stores the reading", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "Gangnam Style", creator: "PSY", year: 2012 }));
    await insertLetter(env.DB, letterDraft(it.id, { body: "秘密の手紙の本文です。", bodyJa: "秘密の手紙の本文です。", radioName: "しずく", place: "松本" }));
    create.mockResolvedValue(named({ title: "カンナムスタイル", creator: "サイ" }));
    const out = await ensureItemReading(keyed, env.DB, it);
    expect(out.readingJa).toEqual({ title: "カンナムスタイル", creator: "サイ" });
    expect((await getItem(env.DB, it.id))!.readingJa).toEqual({ title: "カンナムスタイル", creator: "サイ" });
    expect(create).toHaveBeenCalledTimes(1);
    const req = create.mock.calls[0]![0];
    expectInstructedTool(req, "name_readings");
    expect(req.tools[0].input_schema.required).toEqual(["title", "creator"]);
    expect(req.messages).toEqual([{ role: "user", content: "<work>\n題名: Gangnam Style\n作者: PSY\n年: 2012\n種類: music\n</work>" }]);
    expect(JSON.stringify(req)).not.toMatch(/秘密の手紙|しずく|松本/);
  });

  it("never asks again once stored, an empty reading too", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "Blue in Green", creator: "Miles Davis" }));
    create.mockResolvedValue(named({ title: "", creator: "" }));
    const first = await ensureItemReading(keyed, env.DB, it);
    expect(first.readingJa).toEqual({});
    await ensureItemReading(keyed, env.DB, first);
    await ensureItemReadings(keyed, env.DB, [it.id]);
    expect(create).toHaveBeenCalledTimes(1);
    expect((await getItem(env.DB, it.id))!.readingJa).toEqual({});
  });

  it("skips the call for a title and creator in kana alone, and stores an empty reading", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "さくら", creator: "いきものがかり" }));
    expect((await ensureItemReading(keyed, env.DB, it)).readingJa).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["a sentence for a short name", { title: "", creator: "コレハヒョウジサレナイメッセージ" }, {}],
    ["hiragana", { title: "かんなむ", creator: "サイ" }, { creator: "サイ" }],
    ["a reading of digits alone", { title: "ナインティーンエイティーナイン", creator: "" }, {}],
  ])("drops a reading in %s and keeps the rest", async (_why, reply, kept) => {
    const it = await insertItem(env.DB, itemDraft({ title: _why === "a reading of digits alone" ? "1989" : "Gangnam Style", creator: "PSY" }));
    create.mockResolvedValue(named(reply));
    expect((await ensureItemReading(keyed, env.DB, it)).readingJa).toEqual(kept);
  });

  it("keeps no reading that would fail the lead line's checks, or that stands for more than 40 code points", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "Ranking Song", creator: "PSY" }));
    create.mockResolvedValue(named({ title: "ランキングソング", creator: "サイ" }));
    expect((await ensureItemReading(keyed, env.DB, it)).readingJa).toEqual({ creator: "サイ" });
    const long = await insertItem(env.DB, itemDraft({ title: "A".repeat(41), creator: "" }));
    create.mockResolvedValue(named({ title: "エー", creator: "" }));
    expect((await ensureItemReading(keyed, env.DB, long)).readingJa).toEqual({});
  });

  it("stores nothing without Claude or when the answer is out of shape twice, so a later run asks again", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "Gangnam Style", creator: "PSY" }));
    expect(await ensureItemReading(keyless, env.DB, it)).toEqual(it);
    expect(create).not.toHaveBeenCalled();
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    expect(await ensureItemReading(keyed, env.DB, it)).toEqual(it);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await getItem(env.DB, it.id)).not.toHaveProperty("readingJa");
  });

  it("marks the work's voiced Japanese units to be voiced again when a reading is stored", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "Gangnam Style", creator: "PSY" }));
    const l = await insertLetter(env.DB, letterDraft(it.id));
    await upsertUnit(env.DB, { letterId: l.id, lang: "ja", intro: "a", after: "b", verified: true, audioReady: true });
    create.mockResolvedValue(named({ title: "", creator: "サイ" }));
    await ensureItemReading(keyed, env.DB, it);
    expect((await env.DB.prepare("SELECT audio_ready FROM units").first<{ audio_ready: number }>())?.audio_ready).toBe(0);
  });
});
