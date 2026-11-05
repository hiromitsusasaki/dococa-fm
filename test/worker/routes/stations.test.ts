import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener, updateListener } from "../../../src/worker/db/listeners";
import app from "../../../src/worker/index";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { newSession } from "./helpers";

const ORIGIN = "http://127.0.0.1:5173";
const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;
type Body = { episode: { id: string; segments: { slot: string; itemId: string }[]; items: Record<string, unknown>; cloudTts: boolean }; station: { key: string; label: string } };

const postNext = (key: string, cookie: string, e: object = env, headers: Record<string, string> = { origin: ORIGIN }) =>
  app.request(`/stations/${key}/next`, { method: "POST", headers: { cookie, ...headers } }, e);

/** Three far items with a letter from someone else, so the world station has something to air. */
async function seedWorld() {
  const other = await createListener(env.DB);
  for (let n = 0; n < 3; n++) {
    const it = await insertItem(env.DB, itemDraft({ title: `far-${n}`, externalIds: { itunes: String(100 + n) } }));
    await insertLetter(env.DB, letterDraft(it.id, { listenerId: other.id, body: `手紙${n}`, bodyJa: `手紙${n}` }));
  }
}

beforeEach(async () => {
  await resetDb(env.DB);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /stations/:key/next", () => {
  it("world: builds a far-only episode and returns it as json with the station label", async () => {
    await seedWorld();
    const cookie = await newSession();
    const res = await postNext("world", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.episode.segments.length).toBeGreaterThanOrEqual(1);
    expect(body.episode.segments.every((s) => s.slot === "far")).toBe(true);
    expect(Object.keys(body.episode.items).length).toBeGreaterThanOrEqual(1);
    expect(body.episode.cloudTts).toBe(false);
    expect(body.station.key).toBe("world");
    expect(body.station.label).not.toBe("");
  });

  it("refuses a cross-site post", async () => {
    await seedWorld();
    const cookie = await newSession();
    const res = await postNext("world", cookie, env, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("answers 404 for an unknown key and an unknown slug", async () => {
    const cookie = await newSession();
    expect((await postNext("nonsense", cookie)).status).toBe(404);
    const res = await postNext("s:nobody", cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "station" });
  });

  it("a station that is not public is a 404 too", async () => {
    const owner = await createListener(env.DB);
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: false });
    expect((await postNext("s:hiro", await newSession())).status).toBe(404);
  });

  it("public: airs the owner's favourites to another listener", async () => {
    const owner = await createListener(env.DB, { radioName: "ヒロ" });
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true });
    const fav = await insertItem(env.DB, itemDraft({ title: "owner-fav" }));
    await upsertHistory(env.DB, [{ listenerId: owner.id, itemId: fav.id, source: "manual", occurredAt: null, rank: 1 }]);
    const res = await postNext("s:hiro", await newSession());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.episode.segments.map((s) => s.itemId)).toEqual([fav.id]);
    expect(body.station.key).toBe("s:hiro");
    expect(body.station.label).toContain("ヒロ");
  });

  it("answers 429 json at the daily limit", async () => {
    await seedWorld();
    const cookie = await newSession();
    const keyed = { ...env, EPISODE_DAILY_LIMIT: "1" };
    expect((await postNext("world", cookie, keyed)).status).toBe(200);
    const res = await postNext("world", cookie, keyed);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "limit" });
  });

  it("answers 409 when there is nothing to play", async () => {
    const res = await postNext("world", await newSession());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "empty" });
  });
});

describe("GET /stations/:key.json", () => {
  it("answers 204 before any episode, then the latest verified one in the same shape", async () => {
    await seedWorld();
    const cookie = await newSession();
    expect((await app.request("/stations/world.json", { headers: { cookie } }, env)).status).toBe(204);
    const made = (await (await postNext("world", cookie)).json()) as Body;
    const res = await app.request("/stations/world.json", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.episode.id).toBe(made.episode.id);
    expect(body.station.key).toBe("world");
  });

  it("does not show another listener's episode, and 404s a bad key", async () => {
    await seedWorld();
    await postNext("world", await newSession());
    const stranger = await newSession();
    expect((await app.request("/stations/world.json", { headers: { cookie: stranger } }, env)).status).toBe(204);
    expect((await app.request("/stations/bogus.json", { headers: { cookie: stranger } }, env)).status).toBe(404);
    expect(idOf(stranger)).toBeTruthy();
  });
});
