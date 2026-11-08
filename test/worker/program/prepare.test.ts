import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { getUnits, upsertUnit } from "../../../src/worker/db/units";
import type { Env } from "../../../src/worker/env";
import { prepareBatch, prepareLetter } from "../../../src/worker/program/prepare";
import type { Item, Letter } from "../../../src/worker/types";
import { noNames, stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetBucket } from "../../helpers/bucket";
import { claimTts } from "../../../src/worker/tts/claim";
import { audioKey, voiceOf } from "../../../src/worker/tts/audio";
import { replaceUnit } from "../../../src/worker/db/units";
import { resetDb } from "../../helpers/db";
import { json } from "../../helpers/fetch";
import { makeServiceAccount, primeToken } from "../../helpers/service-account";
import { itemDraft, letterDraft } from "../db/helpers";
import { fakeAi } from "../../helpers/ai";
import { getItem, getItemVecs } from "../../../src/worker/db/items";

const GOOGLE = "https://texttospeech.googleapis.com/v1/text:synthesize";
const sa = await makeServiceAccount();
const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test", GOOGLE_TTS_SA_JSON: sa.json } as Env;
const keylessTts = { ...keyed, GOOGLE_TTS_SA_JSON: "" } as Env;
const audio = btoa(String.fromCharCode(1, 2, 3));

let create: ReturnType<typeof stubAnthropic>;
/** The work-reading call (`name_readings`), kept out of `create`'s count. */
let names: Mock<(req: any) => unknown>;
let google: Mock<() => Response | Promise<Response>>;
/** Claude is stubbed by the helper; Google is added in front of it. */
function stubBoth(googleReply: () => Response | Promise<Response> = () => json({ audioContent: audio })) {
  names = vi.fn<(req: any) => unknown>(noNames);
  create = stubAnthropic({ names });
  create.mockResolvedValue(toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" }));
  const claudeFetch = globalThis.fetch;
  google = vi.fn<() => Response | Promise<Response>>(googleReply);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(GOOGLE) ? google() : claudeFetch(input, init);
  });
}

async function seed(n = 1, over: Partial<Parameters<typeof letterDraft>[1]> = {}): Promise<{ item: Item; letters: Letter[] }> {
  const item = await insertItem(env.DB, itemDraft({ title: "近くの曲" }));
  // Its reading was asked for already, so the budget tests below count units and clips only.
  await env.DB.prepare("UPDATE items SET reading_ja = '{}' WHERE id = ?").bind(item.id).run();
  const letters: Letter[] = [];
  for (let i = 0; i < n; i++) {
    const letter = await insertLetter(env.DB, letterDraft(item.id, { radioName: `しずく${i}`, place: "松本", body: `雨の日に聴きました${i}。`, bodyJa: `雨の日に聴きました${i}。`, ...over }));
    // `insertLetter` stamps the current millisecond and a random id, so letters seeded back to back tie on `created_at`
    // and the oldest-first listings would order them by id. A second apart keeps "letter 0 is first" true.
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    await env.DB.prepare("UPDATE letters SET created_at = ? WHERE id = ?").bind(createdAt, letter.id).run();
    letters.push({ ...letter, createdAt });
  }
  return { item, letters };
}

const unitOf = async (id: string) => (await getUnits(env.DB, [id], "ja")).get(id);

beforeEach(async () => {
  await resetDb(env.DB);
  await resetBucket(env.BUCKET);
  await primeToken(sa.json);
  stubBoth();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prepareLetter", () => {
  it("makes the unit with one Claude call and voices lead, intro, hand-over, letter and after", async () => {
    const { letters } = await seed();
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id, "ja")).toEqual({ units: 1, audio: 5, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(google).toHaveBeenCalledTimes(10); // each line is short, so it is synthesized twice
    expect(await unitOf(letters[0]!.id)).toMatchObject({ verified: true, audioReady: true });
  });

  it("voices the spoken text of the lead and the talk, with the readings the new unit gave, and the letter as written", async () => {
    const it = await insertItem(env.DB, itemDraft({ title: "Gangnam Style", creator: "PSY" }));
    const l = await insertLetter(env.DB, letterDraft(it.id, { radioName: "しずく", place: "松本", body: "PSYで踊った夏。", bodyJa: "PSYで踊った夏。" }));
    create.mockResolvedValue(toolUse("write_unit", { intro: "PSYらしい明るい一曲です。", after: "いい夏でしたね。", readings: [{ text: "PSY", reading: "サイ" }] }));
    names.mockImplementation(() => toolUse("name_readings", { title: "", creator: "サイ" }));
    expect(await prepareLetter(keyed, env.DB, l.id, "ja")).toEqual({ units: 1, audio: 5, failed: 0 });
    expect(names).toHaveBeenCalledTimes(1);
    const has = async (text: string) => (await env.BUCKET.head(await audioKey("ja", voiceOf(keyed), text))) !== null;
    expect(await has("サイの「Gangnam Style」という曲の紹介です。")).toBe(true);
    expect(await has("PSYの「Gangnam Style」という曲の紹介です。")).toBe(false);
    expect(await has("サイらしい明るい一曲です。")).toBe(true);
    expect(await has("PSYらしい明るい一曲です。")).toBe(false);
    expect(await has("PSYで踊った夏。")).toBe(true);
    expect(await unitOf(l.id)).toMatchObject({ verified: true, audioReady: true });
  });

  it("voices only the lead, the hand-over and the letter for a unit that failed verification", async () => {
    const { letters } = await seed();
    create.mockImplementation(() => toolUse("write_unit", { intro: "どうぞお聴きください。", after: "いいお便りでした。" }));
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id, "ja")).toEqual({ units: 1, audio: 3, failed: 0 });
    expect(await unitOf(letters[0]!.id)).toMatchObject({ verified: false, audioReady: false });
    expect(google).toHaveBeenCalledTimes(6);
  });

  it("with no language named, makes the ja and the en unit and voices both", async () => {
    const { letters } = await seed(1, { bodyEn: "It rained the day I heard it." });
    const id = letters[0]!.id;
    create.mockImplementation((req: { system: string }) =>
      toolUse("write_unit", req.system.startsWith("You are") ? { intro: "A quiet piece.", after: "A lovely letter." } : { intro: "静かな一曲です。", after: "いいお便りでした。" }),
    );
    expect(await prepareLetter(keyed, env.DB, id)).toEqual({ units: 2, audio: 10, failed: 0 });
    expect(await unitOf(id)).toMatchObject({ intro: "静かな一曲です。", audioReady: true });
    expect((await getUnits(env.DB, [id], "en")).get(id)).toMatchObject({ intro: "A quiet piece.", verified: true, audioReady: true });
    expect(google).toHaveBeenCalledTimes(20);
  });

  it("makes both units before any audio: ja unit, en unit, then the ja clips, then the en clips", async () => {
    const { letters } = await seed(1, { bodyEn: "It rained the day I heard it." });
    const order: string[] = [];
    create.mockImplementation((req: { system: string }) => {
      const en = req.system.startsWith("You are");
      order.push(en ? "unit:en" : "unit:ja");
      return toolUse("write_unit", en ? { intro: "A quiet piece.", after: "A lovely letter." } : { intro: "静かな一曲です。", after: "いいお便りでした。" });
    });
    google.mockImplementation(() => {
      order.push("clip");
      return json({ audioContent: audio });
    });
    const head = vi.spyOn(env.BUCKET, "head");
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id)).toEqual({ units: 2, audio: 10, failed: 0 });
    expect(order).toEqual(["unit:ja", "unit:en", ...Array(20).fill("clip")]);
    // The clips are asked for in the order ja (tts/v4/ja/...) then en.
    const langs = head.mock.calls.map((c) => String(c[0]).split("/")[2]);
    expect(langs.slice(0, 5)).toEqual(Array(5).fill("ja"));
    expect(langs.slice(-5)).toEqual(Array(5).fill("en"));
  });

  it("does nothing more the second time", async () => {
    const { letters } = await seed();
    await prepareLetter(keyed, env.DB, letters[0]!.id, "ja");
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id, "ja")).toEqual({ units: 0, audio: 0, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(google).toHaveBeenCalledTimes(10);
  });

  it("ignores a rejected letter, a reaction and an unknown id", async () => {
    const { item, letters } = await seed(1, { status: "rejected" });
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: letters[0]!.id }));
    for (const id of [letters[0]!.id, reply.id, "nope"]) expect(await prepareLetter(keyed, env.DB, id, "ja")).toEqual({ units: 0, audio: 0, failed: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });

  it("makes the unit and skips audio when no cloud voice is configured", async () => {
    const { letters } = await seed();
    expect(await prepareLetter(keylessTts, env.DB, letters[0]!.id, "ja")).toEqual({ units: 1, audio: 0, failed: 0 });
    expect(google).not.toHaveBeenCalled();
    expect(await unitOf(letters[0]!.id)).toMatchObject({ verified: true, audioReady: false });
  });

  it("counts failed clips and leaves the unit not ready", async () => {
    stubBoth(() => json({ error: "x" }, 500));
    const { letters } = await seed();
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id, "ja")).toEqual({ units: 1, audio: 0, failed: 5 });
    expect(await unitOf(letters[0]!.id)).toMatchObject({ audioReady: false });
  });

  it("makes nothing when Claude is unavailable and never throws", async () => {
    const { letters } = await seed();
    expect(await prepareLetter({ ...keyed, ANTHROPIC_API_KEY: "" } as Env, env.DB, letters[0]!.id, "ja")).toEqual({ units: 0, audio: 0, failed: 0 });
    create.mockRejectedValue(new Error("down"));
    const r = await prepareLetter(keyed, env.DB, letters[0]!.id, "ja");
    expect(r).toEqual({ units: 0, audio: 0, failed: 1 });
    expect(await unitOf(letters[0]!.id)).toBeUndefined();
  });

  it("resolves when something inside throws, and logs the error name only", async () => {
    const broken = { prepare: () => { throw new Error("D1_ERROR: 雨の日に聴きました"); } } as unknown as D1Database;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await prepareLetter(keyed, broken, "any", "ja")).toEqual({ units: 0, audio: 0, failed: 1 });
    const logged = error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("prepare failed: Error");
    expect(logged).not.toContain("雨の日");
    expect(logged).not.toContain("D1_ERROR");
  });

  it("keeps a verified unit that another run tries to replace while its clips are made, and flags it", async () => {
    const { letters } = await seed();
    const id = letters[0]!.id;
    let calls = 0;
    stubBoth(async () => {
      if (++calls === 4) await upsertUnit(env.DB, { letterId: id, lang: "ja", intro: "別の紹介です。", after: "別の感想です。", verified: true, audioReady: false });
      return json({ audioContent: audio });
    });
    await prepareLetter(keyed, env.DB, id, "ja");
    expect(await unitOf(id)).toMatchObject({ intro: "静かな一曲です。", audioReady: true });
  });

  it("skips a letter whose unit another run is making, without counting a failure", async () => {
    const { letters } = await seed();
    const id = letters[0]!.id;
    await claimTts(env.DB, `unit:${id}:ja`);
    expect(await prepareLetter(keyed, env.DB, id, "ja")).toEqual({ units: 0, audio: 0, failed: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });
});

describe("prepareBatch", () => {
  it("embeds the works without a vector first, then the letters, one budget unit per 20, and reports how many are left", async () => {
    const { item, letters } = await seed(2);
    const others = [];
    for (let n = 0; n < 20; n++) others.push(await insertItem(env.DB, itemDraft({ title: `other ${n}`, externalIds: {} })));
    const { AI, calls } = fakeAi();
    const r = await prepareBatch({ ...keylessTts, AI }, env.DB, 4);
    expect(calls.map((c) => c.text.length)).toEqual([20, 1, 2]);
    expect(calls[2]!.text).toEqual(letters.map((l) => `近くの曲 — ${item.creator}${item.year ? ` (${item.year})` : ""} [${item.kind}]\n${l.body}`).reverse());
    expect((await getItemVecs(env.DB, [item.id, ...others.map((o) => o.id)])).size).toBe(21);
    // The work's vector is now mixed with its letters'.
    expect((await env.DB.prepare("SELECT vec_mix FROM items WHERE id = ?").bind(item.id).first<{ vec_mix: unknown }>())?.vec_mix).not.toBeNull();
    // 21 works and 2 letters took three units of four: one letter job is left.
    expect(r).toEqual({ units: 1, audio: 0, failed: 0, remaining: { vectors: 0, letterVecs: 0, readings: 0, units: { ja: 1, en: 2 }, audio: { ja: 1, en: 0 }, gaveUp: { ja: 0, en: 0 } } });
  });

  it("without Workers AI makes no vector, spends nothing on them and counts them all", async () => {
    await seed(1);
    const r = await prepareBatch(keylessTts, env.DB, 2);
    expect(r).toMatchObject({ units: 2, remaining: { vectors: 1, letterVecs: 1 } });
  });

  it("spends `limit` across both languages, ja first then en, and reports what remains of each", async () => {
    const { letters } = await seed(3);
    const order: string[] = [];
    create.mockImplementation((req: { system: string; messages: { content: string }[] }) => {
      const lang = req.system.startsWith("You are") ? "en" : "ja";
      order.push(`${lang}:${letters.findIndex((l) => req.messages[0]!.content.includes(l.body))}`);
      return toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" });
    });
    const r = await prepareBatch(keylessTts, env.DB, 4);
    expect(r).toEqual({ units: 4, audio: 0, failed: 0, remaining: { vectors: 1, letterVecs: 3, readings: 0, units: { ja: 0, en: 2 }, audio: { ja: 3, en: 1 }, gaveUp: { ja: 0, en: 0 } } });
    expect(order).toEqual(["ja:0", "ja:1", "ja:2", "en:0"]);
    expect((await getUnits(env.DB, letters.map((l) => l.id), "en")).size).toBe(1);
  });

  it("runs exactly `limit` jobs in one run: limit 3 with two letters lacking both units makes ja, ja, en", async () => {
    const { letters } = await seed(2);
    const order: string[] = [];
    create.mockImplementation((req: { system: string; messages: { content: string }[] }) => {
      const lang = req.system.startsWith("You are") ? "en" : "ja";
      order.push(`${lang}:${letters.findIndex((l) => req.messages[0]!.content.includes(l.body))}`);
      return toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" });
    });
    const r = await prepareBatch(keyed, env.DB, 3);
    expect(order).toEqual(["ja:0", "ja:1", "en:0"]);
    expect(r).toMatchObject({ units: 3, failed: 0, remaining: { units: { ja: 0, en: 1 }, audio: { ja: 0, en: 0 } } });
  });

  it("spends the whole budget when the audio listing starts with a letter this run already took", async () => {
    const { letters } = await seed(4);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    for (const [i, l] of letters.entries()) {
      await upsertUnit(env.DB, { letterId: l.id, lang: "en", intro: "A quiet piece.", after: "A lovely letter.", verified: true, audioReady: true });
      if (i > 0) await upsertUnit(env.DB, { letterId: l.id, lang: "ja", intro: `紹介${i}です。`, after: `感想${i}です。`, verified: true, audioReady: false, createdAt: later });
    }
    // The first clip of the run fails (a short line is made twice, so both of its attempts), so the letter whose unit is made now stays first in the audio listing.
    let calls = 0;
    stubBoth(() => (++calls <= 2 ? json({ error: "x" }, 500) : json({ audioContent: audio })));
    const r = await prepareBatch(keyed, env.DB, 3);
    expect(r).toMatchObject({ units: 1, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 2, en: 0 } } });
    // Two of the three older units were voiced (they share created_at, so the listing orders them by id).
    const ready = await Promise.all(letters.slice(1).map(async (l) => (await unitOf(l.id))!.audioReady));
    expect(ready.filter(Boolean)).toHaveLength(2);
    expect(await unitOf(letters[0]!.id)).toMatchObject({ audioReady: false });
  });

  it("spends the whole budget on audio when there is no unit work", async () => {
    await seed(3);
    await prepareBatch(keylessTts, env.DB, 20);
    create.mockClear();
    const r = await prepareBatch(keyed, env.DB, 4);
    expect(create).not.toHaveBeenCalled();
    expect(r).toMatchObject({ units: 0, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 0, en: 2 } } });
  });

  it("goes on to newer letters when the oldest one cannot get a unit, and stops only after three misses in a row", async () => {
    const { letters } = await seed(2);
    await env.DB.prepare("UPDATE letters SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").bind(letters[0]!.id).run();
    const bad = letters[0]!.bodyJa;
    create.mockImplementation((req: any) => (String(req.messages[0].content).includes(bad) ? toolUse("write_unit", { intro: 1 }) : toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" })));
    const r = await prepareBatch(keylessTts, env.DB, 20);
    expect(r).toMatchObject({ units: 2, failed: 2, remaining: { units: { ja: 1, en: 1 }, audio: { ja: 1, en: 1 } } });
    expect(await unitOf(letters[1]!.id)).toBeDefined();
    expect(await unitOf(letters[0]!.id)).toBeUndefined();

    await resetDb(env.DB);
    const many = await seed(5);
    create.mockRejectedValue(new Error("down"));
    const out = await prepareBatch(keylessTts, env.DB, 20);
    // The outage counter is shared: after three misses in ja, en is not tried either.
    expect(out).toMatchObject({ units: 0, failed: 3, remaining: { units: { ja: 5, en: 5 } } });
    expect(many.letters).toHaveLength(5);
  });

  it("counts a letter whose run throws toward the outage stop, like one that gets no unit", async () => {
    await seed(5);
    const throwing = {
      prepare: (sql: string) => {
        if (sql.startsWith("SELECT * FROM units WHERE lang")) throw new Error("D1_ERROR: down");
        return env.DB.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
    } as unknown as D1Database;
    const r = await prepareBatch(keylessTts, throwing, 20);
    expect(r).toMatchObject({ units: 0, failed: 3, remaining: { units: { ja: 5, en: 5 } } });
    expect(create).not.toHaveBeenCalled();
  });

  it("voices units that still lack audio, once the key exists", async () => {
    const { letters } = await seed(2);
    await prepareBatch(keylessTts, env.DB, 20);
    const r = await prepareBatch(keyed, env.DB, 20);
    // The stubbed intro and after, and the work's lead, are the same text for both letters, so their clips are shared.
    expect(r).toEqual({ units: 0, audio: 14, failed: 0, remaining: { vectors: 1, letterVecs: 2, readings: 0, units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 }, gaveUp: { ja: 0, en: 0 } } });
    expect(create).toHaveBeenCalledTimes(4);
    expect(await unitOf(letters[1]!.id)).toMatchObject({ audioReady: true });
  });

  it("voices at most `limit` units in all, ja first", async () => {
    await seed(3);
    await prepareBatch(keylessTts, env.DB, 20);
    const r = await prepareBatch(keyed, env.DB, 1);
    expect(r).toMatchObject({ units: 0, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 2, en: 3 } } });
  });

  it("stops making audio at the first limit answer, while units are still made", async () => {
    await seed(2);
    const r = await prepareBatch({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "4" } as Env, env.DB, 20);
    expect(r).toMatchObject({ units: 4, audio: 2, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 2, en: 2 } } });
    expect(google).toHaveBeenCalledTimes(4); // two short lines, two attempts each
  });

  it("skips busy letters without counting them toward the outage stop", async () => {
    const { letters } = await seed(5);
    for (const l of letters.slice(0, 4)) await claimTts(env.DB, `unit:${l.id}:ja`);
    const r = await prepareBatch(keylessTts, env.DB, 20);
    expect(r).toMatchObject({ units: 6, failed: 0, remaining: { units: { ja: 4, en: 0 } } });
    expect(await unitOf(letters[4]!.id)).toBeDefined();
  });

  it("halts the unit phase at UNIT_DAILY_LIMIT without counting a failure, and still voices stored units", async () => {
    const { letters } = await seed(3);
    await upsertUnit(env.DB, { letterId: letters[0]!.id, lang: "ja", intro: "静かな一曲です。", after: "いいお便りでした。", verified: true, audioReady: false, createdAt: "2020-01-01T00:00:00.000Z" });
    const r = await prepareBatch({ ...keyed, UNIT_DAILY_LIMIT: "1" } as Env, env.DB, 20);
    expect(create).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ units: 1, failed: 0, remaining: { units: { ja: 1, en: 3 }, audio: { ja: 0, en: 0 } } });
    expect(await unitOf(letters[0]!.id)).toMatchObject({ audioReady: true });
    expect(await unitOf(letters[1]!.id)).toMatchObject({ audioReady: true });

    create.mockClear();
    expect(await prepareBatch({ ...keyed, UNIT_DAILY_LIMIT: "0" } as Env, env.DB, 20)).toMatchObject({ units: 0, audio: 0, failed: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("leaves a found voice without a source alone, since it can never be verified", async () => {
    const { item } = await seed(0);
    for (const sourceUrl of [null, "", "  "]) await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl, sourceAuthor: "@x", radioName: "" }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://youtu.be/x", sourceAuthor: " ", radioName: "" }));
    expect(await prepareBatch(keyed, env.DB, 20)).toEqual({ units: 0, audio: 0, failed: 0, remaining: { vectors: 1, letterVecs: 0, readings: 0, units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 }, gaveUp: { ja: 0, en: 0 } } });
    expect(create).not.toHaveBeenCalled();
    const sourced = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://youtu.be/y", sourceAuthor: "@jazzcat", radioName: "", body: "雨に合う。", bodyJa: "雨に合う。" }));
    expect(await prepareBatch(keyed, env.DB, 20)).toMatchObject({ units: 2, failed: 0 });
    expect(await unitOf(sourced.id)).toBeDefined();
  });

  it("marks a unit whose line gave up (six paid calls, no clip) and skips it from then on", async () => {
    const { letters } = await seed(1);
    const l = letters[0]!;
    const key = await audioKey("ja", "male", l.bodyJa);
    await env.DB.prepare("INSERT INTO tts_audio (key, lang, voice, bytes, synth_count, created_at) VALUES (?, 'ja', 'male', 0, 6, ?)").bind(key, new Date().toISOString()).run();
    const audioReadyOf = async (lang: string) => (await env.DB.prepare("SELECT audio_ready AS a FROM units WHERE letter_id = ? AND lang = ?").bind(l.id, lang).first<{ a: number }>())?.a;

    const first = await prepareBatch(keyed, env.DB, 20);
    expect(first.remaining).toEqual({ vectors: 1, letterVecs: 1, readings: 0, units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 }, gaveUp: { ja: 1, en: 0 } });
    expect(await audioReadyOf("ja")).toBe(2);
    expect(await audioReadyOf("en")).toBe(1);
    expect(await unitOf(l.id)).toMatchObject({ audioReady: false });

    google.mockClear();
    const second = await prepareBatch(keyed, env.DB, 20);
    expect(second).toMatchObject({ units: 0, audio: 0, failed: 0, remaining: { audio: { ja: 0, en: 0 }, gaveUp: { ja: 1, en: 0 } } });
    expect(google).not.toHaveBeenCalled();

    // The owner's remake puts it back in the listing.
    await replaceUnit(env.DB, { letterId: l.id, lang: "ja", intro: "新しい紹介です。", after: "新しい感想です。" });
    expect(await audioReadyOf("ja")).toBe(0);
    expect((await prepareBatch(keylessTts, env.DB, 20)).remaining).toMatchObject({ audio: { ja: 1, en: 0 }, gaveUp: { ja: 0, en: 0 } });
  });

  it("leaves a unit unmarked when the cap stops its clips after a line gave up, so the next run voices the rest", async () => {
    const { letters } = await seed(1);
    const l = letters[0]!;
    await prepareBatch(keylessTts, env.DB, 20);
    const ja = (await unitOf(l.id))!;
    // The intro is the unit's first line: it gives up (its calls were yesterday, outside today's cap), the
    // hand-over takes today's one slot, and the cap refuses the letter.
    const key = await audioKey("ja", "male", ja.intro);
    await env.DB.prepare("INSERT INTO tts_audio (key, lang, voice, bytes, synth_count, created_at) VALUES (?, 'ja', 'male', 0, 6, ?)").bind(key, new Date(Date.now() - 48 * 3600_000).toISOString()).run();
    google.mockClear();
    await prepareBatch({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "1" } as Env, env.DB, 20);
    expect(google).toHaveBeenCalledTimes(2); // the hand-over is short: two attempts
    expect((await env.DB.prepare("SELECT audio_ready AS a FROM units WHERE letter_id = ? AND lang = 'ja'").bind(l.id).first<{ a: number }>())?.a).toBe(0);
  });

  it("asks for the works' readings after the vectors and before the units, one budget unit each, and counts what is left", async () => {
    const a = await insertItem(env.DB, itemDraft({ title: "Gangnam Style", creator: "PSY" }));
    const b = await insertItem(env.DB, itemDraft({ title: "Hangover", creator: "PSY" }));
    await insertLetter(env.DB, letterDraft(a.id));
    await insertLetter(env.DB, letterDraft(b.id));
    const order: string[] = [];
    names.mockImplementation(() => (order.push("reading"), toolUse("name_readings", { title: "", creator: "サイ" })));
    create.mockImplementation(() => (order.push("unit"), toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" })));
    const r = await prepareBatch(keyed, env.DB, 1);
    expect(r).toMatchObject({ units: 0, remaining: { readings: 1, units: { ja: 2, en: 2 } } });
    expect(order).toEqual(["reading"]);
    const s2 = await prepareBatch(keyed, env.DB, 2);
    expect(s2).toMatchObject({ units: 1, remaining: { readings: 0 } });
    expect(order).toEqual(["reading", "reading", "unit"]);
    expect((await getItem(env.DB, a.id))!.readingJa ?? (await getItem(env.DB, b.id))!.readingJa).toEqual({ creator: "サイ" });
  });

  it("counts a work whose reading call fails as failed, stores an empty reading, and lists it no more", async () => {
    const a = await insertItem(env.DB, itemDraft({ title: "Gangnam Style", creator: "PSY" }));
    await insertLetter(env.DB, letterDraft(a.id));
    names.mockImplementation(() => ({ content: [{ type: "text", text: "はい" }] }));
    const r = await prepareBatch(keyed, env.DB, 1);
    expect(r).toMatchObject({ units: 0, failed: 1, remaining: { readings: 0 } });
    expect(names).toHaveBeenCalledTimes(2);
    expect((await getItem(env.DB, a.id))!.readingJa).toEqual({});
    names.mockClear();
    await prepareBatch(keyed, env.DB, 1);
    expect(names).not.toHaveBeenCalled();
  });

  it("never re-makes a letter that was rejected after its unit was made", async () => {
    const { letters } = await seed(1, { status: "rejected" });
    await upsertUnit(env.DB, { letterId: letters[0]!.id, lang: "ja", intro: "a", after: "b", verified: true, audioReady: false });
    const r = await prepareBatch(keyed, env.DB, 20);
    expect(r).toEqual({ units: 0, audio: 0, failed: 0, remaining: { vectors: 1, letterVecs: 0, readings: 0, units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 }, gaveUp: { ja: 0, en: 0 } } });
    expect(create).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });
});
