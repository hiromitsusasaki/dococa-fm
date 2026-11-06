import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { getUnits, upsertUnit } from "../../../src/worker/db/units";
import type { Env } from "../../../src/worker/env";
import { prepareBatch, prepareLetter } from "../../../src/worker/program/prepare";
import type { Item, Letter } from "../../../src/worker/types";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetBucket } from "../../helpers/bucket";
import { resetDb } from "../../helpers/db";
import { json } from "../../helpers/fetch";
import { makeServiceAccount, primeToken } from "../../helpers/service-account";
import { itemDraft, letterDraft } from "../db/helpers";

const GOOGLE = "https://texttospeech.googleapis.com/v1/text:synthesize";
const sa = await makeServiceAccount();
const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test", GOOGLE_TTS_SA_JSON: sa.json } as Env;
const keylessTts = { ...keyed, GOOGLE_TTS_SA_JSON: "" } as Env;
const audio = btoa(String.fromCharCode(1, 2, 3));

let create: ReturnType<typeof stubAnthropic>;
let google: Mock<() => Response | Promise<Response>>;
/** Claude is stubbed by the helper; Google is added in front of it. */
function stubBoth(googleReply: () => Response | Promise<Response> = () => json({ audioContent: audio })) {
  create = stubAnthropic();
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
  const letters: Letter[] = [];
  for (let i = 0; i < n; i++) {
    letters.push(await insertLetter(env.DB, letterDraft(item.id, { radioName: `しずく${i}`, place: "松本", body: `雨の日に聴きました${i}。`, bodyJa: `雨の日に聴きました${i}。`, ...over })));
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
  it("makes the unit with one Claude call and voices intro, hand-over, letter and after", async () => {
    const { letters } = await seed();
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id, "ja")).toEqual({ units: 1, audio: 4, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(google).toHaveBeenCalledTimes(4);
    expect(await unitOf(letters[0]!.id)).toMatchObject({ verified: true, audioReady: true });
  });

  it("with no language named, makes the ja and the en unit and voices both", async () => {
    const { letters } = await seed(1, { bodyEn: "It rained the day I heard it." });
    const id = letters[0]!.id;
    create.mockImplementation((req: { system: string }) =>
      toolUse("write_unit", req.system.startsWith("You are") ? { intro: "A quiet piece.", after: "A lovely letter." } : { intro: "静かな一曲です。", after: "いいお便りでした。" }),
    );
    expect(await prepareLetter(keyed, env.DB, id)).toEqual({ units: 2, audio: 8, failed: 0 });
    expect(await unitOf(id)).toMatchObject({ intro: "静かな一曲です。", audioReady: true });
    expect((await getUnits(env.DB, [id], "en")).get(id)).toMatchObject({ intro: "A quiet piece.", verified: true, audioReady: true });
    expect(google).toHaveBeenCalledTimes(8);
  });

  it("does nothing more the second time", async () => {
    const { letters } = await seed();
    await prepareLetter(keyed, env.DB, letters[0]!.id, "ja");
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id, "ja")).toEqual({ units: 0, audio: 0, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(google).toHaveBeenCalledTimes(4);
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
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id, "ja")).toEqual({ units: 1, audio: 0, failed: 4 });
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

  it("does not flag a unit that was replaced while its clips were made", async () => {
    const { letters } = await seed();
    const id = letters[0]!.id;
    let calls = 0;
    stubBoth(async () => {
      if (++calls === 4) await upsertUnit(env.DB, { letterId: id, lang: "ja", intro: "別の紹介です。", after: "別の感想です。", verified: true, audioReady: false });
      return json({ audioContent: audio });
    });
    await prepareLetter(keyed, env.DB, id, "ja");
    expect(await unitOf(id)).toMatchObject({ intro: "別の紹介です。", audioReady: false });
    // The next run voices the new text and then flags it.
    await prepareLetter(keyed, env.DB, id, "ja");
    expect(await unitOf(id)).toMatchObject({ audioReady: true });
  });
});

describe("prepareBatch", () => {
  it("makes at most `limit` units per language, ja first then en, and reports what remains of each", async () => {
    const { letters } = await seed(3);
    const order: string[] = [];
    create.mockImplementation((req: { system: string; messages: { content: string }[] }) => {
      const lang = req.system.startsWith("You are") ? "en" : "ja";
      order.push(`${lang}:${letters.findIndex((l) => req.messages[0]!.content.includes(l.body))}`);
      return toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" });
    });
    const r = await prepareBatch(keylessTts, env.DB, 2);
    expect(r).toEqual({ units: 4, audio: 0, failed: 0, remaining: { units: { ja: 1, en: 1 }, audio: { ja: 2, en: 2 } } });
    expect(order).toEqual(["ja:0", "ja:1", "en:0", "en:1"]);
    expect((await getUnits(env.DB, letters.map((l) => l.id), "en")).size).toBe(2);
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

  it("voices units that still lack audio, once the key exists", async () => {
    const { letters } = await seed(2);
    await prepareBatch(keylessTts, env.DB, 20);
    const r = await prepareBatch(keyed, env.DB, 20);
    // The stubbed intro and after are the same text for both letters, so their clips are shared.
    expect(r).toEqual({ units: 0, audio: 12, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 } } });
    expect(create).toHaveBeenCalledTimes(4);
    expect(await unitOf(letters[1]!.id)).toMatchObject({ audioReady: true });
  });

  it("voices at most `limit` units per language", async () => {
    await seed(3);
    await prepareBatch(keylessTts, env.DB, 20);
    const r = await prepareBatch(keyed, env.DB, 1);
    expect(r).toMatchObject({ units: 0, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 2, en: 2 } } });
  });

  it("stops making audio at the first limit answer, while units are still made", async () => {
    await seed(2);
    const r = await prepareBatch({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "2" } as Env, env.DB, 20);
    expect(r).toMatchObject({ units: 4, audio: 2, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 2, en: 2 } } });
    expect(google).toHaveBeenCalledTimes(2);
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
    expect(await prepareBatch(keyed, env.DB, 20)).toEqual({ units: 0, audio: 0, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 } } });
    expect(create).not.toHaveBeenCalled();
    const sourced = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://youtu.be/y", sourceAuthor: "@jazzcat", radioName: "", body: "雨に合う。", bodyJa: "雨に合う。" }));
    expect(await prepareBatch(keyed, env.DB, 20)).toMatchObject({ units: 2, failed: 0 });
    expect(await unitOf(sourced.id)).toBeDefined();
  });

  it("never re-makes a letter that was rejected after its unit was made", async () => {
    const { letters } = await seed(1, { status: "rejected" });
    await upsertUnit(env.DB, { letterId: letters[0]!.id, lang: "ja", intro: "a", after: "b", verified: true, audioReady: false });
    const r = await prepareBatch(keyed, env.DB, 20);
    expect(r).toEqual({ units: 0, audio: 0, failed: 0, remaining: { units: { ja: 0, en: 0 }, audio: { ja: 0, en: 0 } } });
    expect(create).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });
});
