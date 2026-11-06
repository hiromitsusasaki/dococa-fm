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
let google: Mock<() => Response>;
/** Claude is stubbed by the helper; Google is added in front of it. */
function stubBoth(googleReply: () => Response = () => json({ audioContent: audio })) {
  create = stubAnthropic();
  create.mockResolvedValue(toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" }));
  const claudeFetch = globalThis.fetch;
  google = vi.fn<() => Response>(googleReply);
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
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id)).toEqual({ units: 1, audio: 4, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(google).toHaveBeenCalledTimes(4);
    expect(await unitOf(letters[0]!.id)).toMatchObject({ verified: true, audioReady: true });
  });

  it("does nothing more the second time", async () => {
    const { letters } = await seed();
    await prepareLetter(keyed, env.DB, letters[0]!.id);
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id)).toEqual({ units: 0, audio: 0, failed: 0 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(google).toHaveBeenCalledTimes(4);
  });

  it("ignores a rejected letter, a reaction and an unknown id", async () => {
    const { item, letters } = await seed(1, { status: "rejected" });
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: letters[0]!.id }));
    for (const id of [letters[0]!.id, reply.id, "nope"]) expect(await prepareLetter(keyed, env.DB, id)).toEqual({ units: 0, audio: 0, failed: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });

  it("makes the unit and skips audio when no cloud voice is configured", async () => {
    const { letters } = await seed();
    expect(await prepareLetter(keylessTts, env.DB, letters[0]!.id)).toEqual({ units: 1, audio: 0, failed: 0 });
    expect(google).not.toHaveBeenCalled();
    expect(await unitOf(letters[0]!.id)).toMatchObject({ verified: true, audioReady: false });
  });

  it("counts failed clips and leaves the unit not ready", async () => {
    stubBoth(() => json({ error: "x" }, 500));
    const { letters } = await seed();
    expect(await prepareLetter(keyed, env.DB, letters[0]!.id)).toEqual({ units: 1, audio: 0, failed: 4 });
    expect(await unitOf(letters[0]!.id)).toMatchObject({ audioReady: false });
  });

  it("makes nothing when Claude is unavailable and never throws", async () => {
    const { letters } = await seed();
    expect(await prepareLetter({ ...keyed, ANTHROPIC_API_KEY: "" } as Env, env.DB, letters[0]!.id)).toEqual({ units: 0, audio: 0, failed: 0 });
    create.mockRejectedValue(new Error("down"));
    const r = await prepareLetter(keyed, env.DB, letters[0]!.id);
    expect(r).toMatchObject({ units: 0, audio: 0 });
    expect(await unitOf(letters[0]!.id)).toBeUndefined();
  });
});

describe("prepareBatch", () => {
  it("makes at most `limit` units and reports what remains", async () => {
    await seed(3);
    const r = await prepareBatch(keylessTts, env.DB, 2);
    expect(r).toEqual({ units: 2, audio: 0, failed: 0, remaining: { units: 1, audio: 2 } });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("voices units that still lack audio, once the key exists", async () => {
    const { letters } = await seed(2);
    await prepareBatch(keylessTts, env.DB, 20);
    const r = await prepareBatch(keyed, env.DB, 20);
    // The stubbed intro and after are the same text for both letters, so their clips are shared.
    expect(r).toEqual({ units: 0, audio: 6, failed: 0, remaining: { units: 0, audio: 0 } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(await unitOf(letters[1]!.id)).toMatchObject({ audioReady: true });
  });

  it("stops making audio at the first limit answer, while units are still made", async () => {
    await seed(2);
    const r = await prepareBatch({ ...keyed, CLOUD_TTS_GLOBAL_DAILY_LIMIT: "2" } as Env, env.DB, 20);
    expect(r).toMatchObject({ units: 2, audio: 2, failed: 0, remaining: { units: 0, audio: 2 } });
    expect(google).toHaveBeenCalledTimes(2);
  });

  it("never re-makes a letter that was rejected after its unit was made", async () => {
    const { letters } = await seed(1, { status: "rejected" });
    await upsertUnit(env.DB, { letterId: letters[0]!.id, lang: "ja", intro: "a", after: "b", verified: true, audioReady: false });
    const r = await prepareBatch(keyed, env.DB, 20);
    expect(r).toEqual({ units: 0, audio: 0, failed: 0, remaining: { units: 0, audio: 0 } });
    expect(create).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });
});
