import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/worker/index";
import { insertItem, quantise } from "../../src/worker/db/items";
import { angled } from "../helpers/ai";
import { insertLetter } from "../../src/worker/db/letters";
import { createListener, updateListener } from "../../src/worker/db/listeners";
import { getUnits } from "../../src/worker/db/units";
import { countingD1 } from "../helpers/d1-count";
import { resetDb } from "../helpers/db";
import { stubAnthropic, toolUse } from "../helpers/anthropic";
import { json, stubFetch } from "../helpers/fetch";
import { itemDraft, letterDraft } from "./db/helpers";
import { newSession, signedInSession } from "./routes/helpers";

/** Workers Free allows 50 D1 queries per invocation; these are the budgets the hot paths must stay under. */
const START_BUDGET = 50;
/** With every unit stored: the selection, three loads, one units read, the insert. */
const EPISODE_BUDGET = 30;
/**
 * The worst case: no unit made yet. An episode is one segment with one letter (the player asks again for each), so
 * one unit's seven statements on top: the cap read, the claim (two), the liked examples, the write, the read back and
 * the release. Measured at 24 (2026-11-07: 17 without a key, plus 7); the margin is small so a regression shows.
 */
const EPISODE_MAKING_UNITS_BUDGET = 28;
const PER_UNIT = 7;
/**
 * The distance pick (Task 4) adds at most three statements to `next`: the taste, the candidates' vectors (one per 90
 * ids not cached in the isolate) and the exclusions. Without a taste it costs the two taste reads and stops.
 */
const DISTANCE_EXTRA = 3;
/** A cold start (no taste yet) reads the letters from the countries the last two segments did not lead with. */
const COLD_START_EXTRA = 1;

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

  it(`POST /stations/mine/next by distance adds at most ${DISTANCE_EXTRA} statements, a cold start ${COLD_START_EXTRA}, and both stay under ${EPISODE_BUDGET}`, async () => {
    const measure = async (withVectors: boolean, withOwnLetter = true) => {
      await resetDb(env.DB);
      await seedWorld();
      const cookie = await newSession();
      const me = cookie.split("=")[1]!.split(".")[0]!;
      const fav = await insertItem(env.DB, itemDraft({ title: "favourite", externalIds: { itunes: "777" } }));
      // The taste comes from the listener's own letters (Phase 7 Task 7), not from favourites.
      if (withOwnLetter) await insertLetter(env.DB, letterDraft(fav.id, { listenerId: me, body: "my own letter" }));
      if (withVectors) {
        // Written straight to the table so the isolate's vector cache is cold: the worst case.
        const { results } = await env.DB.prepare("SELECT id FROM items ORDER BY id").all<{ id: string }>();
        for (const [i, r] of results.entries()) await env.DB.prepare("UPDATE items SET vec = ? WHERE id = ?").bind(quantise(angled(r.id === fav.id ? 0 : 0.2 + i * 0.05)), r.id).run();
      }
      const counted = countingD1(env.DB);
      const res = await app.request(
        "/stations/mine/next",
        { method: "POST", headers: { cookie, origin: "http://127.0.0.1:5173", "content-type": "application/json" }, body: JSON.stringify({ dial: 0.5 }) },
        { ...env, DB: counted.db },
      );
      expect(res.status).toBe(200);
      return counted.count();
    };
    const byPools = await measure(false);
    const byDistance = await measure(true);
    // Both paths read the exclusions now (the pools never repeat the latest work either); the distance adds at most the vector reads.
    expect(byDistance).toBeGreaterThanOrEqual(byPools);
    expect(byDistance).toBeLessThanOrEqual(byPools + DISTANCE_EXTRA);
    expect(byDistance).toBeLessThan(EPISODE_BUDGET);
    const coldStart = await measure(false, false);
    expect(coldStart).toBe(byPools + COLD_START_EXTRA);
    expect(coldStart).toBeLessThan(EPISODE_BUDGET);
    // Three seeded databases in one test: give it room on a loaded machine.
  }, 15_000);

  it(`POST /stations/s:<slug>/next (a public radio: the owner's letters and the ones they answered) stays under ${EPISODE_BUDGET}`, async () => {
    await seedWorld();
    const owner = await createListener(env.DB, { radioName: "ヒロ" });
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true });
    const other = await createListener(env.DB);
    for (let n = 0; n < 10; n++) {
      const it = await insertItem(env.DB, itemDraft({ title: `owner-${n}`, externalIds: { itunes: `8${n}` } }));
      await insertLetter(env.DB, letterDraft(it.id, { listenerId: owner.id, body: `owner ${n}` }));
      const theirs = await insertLetter(env.DB, letterDraft(it.id, { listenerId: other.id, body: `other ${n}` }));
      await insertLetter(env.DB, letterDraft(it.id, { kind: "reply", listenerId: owner.id, parentLetterId: theirs.id, body: `reply ${n}` }));
    }
    const cookie = await newSession();
    const counted = countingD1(env.DB);
    const res = await app.request("/stations/s:hiro/next", { method: "POST", headers: { cookie, origin: "http://127.0.0.1:5173", "content-type": "application/json" }, body: JSON.stringify({ dial: 0.5 }) }, { ...env, DB: counted.db });
    expect(res.status).toBe(200);
    expect(counted.count()).toBeLessThan(EPISODE_BUDGET);
  });

  it("GET / reads one more statement for a signed-in listener (the reaction notice) and one more for a letter link", async () => {
    await seedWorld();
    const measure = async (cookie: string, path = "/") => {
      const counted = countingD1(env.DB);
      const res = await app.request(path, { headers: { cookie } }, { ...env, DB: counted.db });
      expect(res.status).toBe(200);
      await res.text();
      return counted.count();
    };
    const anon = await newSession();
    const signed = await signedInSession();
    const base = await measure(anon);
    expect(await measure(signed)).toBe(base + 1);
    expect(await measure(anon, "/?letter=abc")).toBe(base + 1);
    // The notice is read where the header is drawn: a JSON read pays nothing for it.
    const json = async (cookie: string) => {
      const counted = countingD1(env.DB);
      await (await app.request("/stations/mine.json", { headers: { cookie } }, { ...env, DB: counted.db })).text();
      return counted.count();
    };
    expect(await json(signed)).toBe(await json(anon));
  });
});
