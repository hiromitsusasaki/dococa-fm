import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/worker/index";
import { insertItem } from "../../src/worker/db/items";
import { insertLetter } from "../../src/worker/db/letters";
import { createListener } from "../../src/worker/db/listeners";
import { getUnits } from "../../src/worker/db/units";
import { countingD1 } from "../helpers/d1-count";
import { resetDb } from "../helpers/db";
import { stubAnthropic, toolUse } from "../helpers/anthropic";
import { json, stubFetch } from "../helpers/fetch";
import { itemDraft, letterDraft } from "./db/helpers";
import { newSession } from "./routes/helpers";

/** Workers Free allows 50 D1 queries per invocation; these are the budgets the hot paths must stay under. */
const START_BUDGET = 50;
/** With every unit stored: the selection, three loads, one units read, the insert. */
const EPISODE_BUDGET = 30;
/**
 * The worst case: no unit made yet, so per letter read (at most 6 segments × 3 letters) six statements on top:
 * the cap read, the claim (two), the write, the read back and the release. Over the Free plan's 50; the app
 * runs on Workers Paid (1000 per invocation, docs/status.md), so this bounds the growth instead.
 */
const EPISODE_MAKING_UNITS_BUDGET = 150;
const PER_UNIT = 6;

const track = (id: number, name: string) => ({ trackId: id, trackName: name, artistName: "Someone", releaseDate: "2001-01-01T00:00:00Z" });

/** A demo-sized database: seed personas wrote on many works, some with replies and found voices. */
async function seedWorld() {
  const writers = [await createListener(env.DB, { demo: true }), await createListener(env.DB, { demo: true })];
  for (let n = 0; n < 20; n++) {
    const it = await insertItem(env.DB, itemDraft({ title: `seeded-${n}`, externalIds: { itunes: `9${n}` } }));
    for (const w of writers) await insertLetter(env.DB, letterDraft(it.id, { listenerId: w.id, radioName: "seed", body: `seed ${n} ${w.id}` }));
    await insertLetter(env.DB, letterDraft(it.id, { kind: "found", sourceAuthor: `@a${n}`, sourceUrl: `https://youtu.be/${n}`, body: `found ${n}` }));
  }
}

const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

beforeEach(async () => {
  await resetDb(env.DB);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("D1 statements per request", () => {
  it(`POST /start with three titles and three one-liners stays under ${START_BUDGET}`, async () => {
    await seedWorld();
    const known: Record<string, number> = { 曲A: 1, 曲B: 2, 曲C: 3 };
    stubFetch([
      ["https://itunes.apple.com/search", (url) => {
        const term = new URL(url).searchParams.get("term") ?? "";
        return json({ results: term in known ? [track(known[term]!, term)] : [] });
      }],
      ["https://www.googleapis.com/books", () => json({ items: [] })],
    ]);
    const cookie = await newSession();
    const counted = countingD1(env.DB);
    const res = await app.request(
      "/start",
      { ...form({ fav1: "曲A", note1: "ずっと聴いている", fav2: "曲B", note2: "雨の日に", fav3: "曲C", note3: "旅の途中で" }), headers: { "content-type": "application/x-www-form-urlencoded", cookie } },
      { ...env, DB: counted.db },
    );
    expect(res.status).toBe(303);
    expect(counted.count()).toBeLessThan(START_BUDGET);
  });

  it(`POST /episodes stays under ${EPISODE_BUDGET}`, async () => {
    await seedWorld();
    const cookie = await newSession();
    const counted = countingD1(env.DB);
    const res = await app.request("/episodes", { method: "POST", headers: { cookie } }, { ...env, DB: counted.db });
    expect(res.status).toBe(303);
    expect(counted.count()).toBeLessThan(EPISODE_BUDGET);
  });

  it(`POST /episodes that makes every unit adds ${PER_UNIT} statements per unit, and stays under ${EPISODE_MAKING_UNITS_BUDGET}`, async () => {
    await seedWorld();
    const cookie = await newSession();
    const keyless = countingD1(env.DB);
    expect((await app.request("/episodes", { method: "POST", headers: { cookie } }, { ...env, DB: keyless.db })).status).toBe(303);
    await env.DB.prepare("DELETE FROM episodes").run();

    stubAnthropic().mockResolvedValue(toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" }));
    const keyed = countingD1(env.DB);
    const res = await app.request("/episodes", { method: "POST", headers: { cookie } }, { ...env, DB: keyed.db, ANTHROPIC_API_KEY: "sk-test" });
    expect(res.status).toBe(303);
    const { results } = await env.DB.prepare("SELECT letter_id FROM units").all<{ letter_id: string }>();
    expect(results.length).toBeGreaterThan(0);
    expect((await getUnits(env.DB, results.map((r) => r.letter_id), "ja")).size).toBe(results.length);
    expect(keyed.count()).toBe(keyless.count() + PER_UNIT * results.length);
    expect(keyed.count()).toBeLessThan(EPISODE_MAKING_UNITS_BUDGET);
  });
});
