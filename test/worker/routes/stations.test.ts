import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { getItemVecs, insertItem, setItemVec } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener, getListener, updateListener } from "../../../src/worker/db/listeners";
import app from "../../../src/worker/index";
import { angled } from "../../helpers/ai";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { newSession, signedInSession } from "./helpers";

const ORIGIN = "http://127.0.0.1:5173";
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
    const writer = await createListener(env.DB);
    await insertLetter(env.DB, letterDraft(fav.id, { listenerId: writer.id, body: "手紙", bodyJa: "手紙" }));
    const res = await postNext("s:hiro", await newSession());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.episode.segments.map((s) => s.itemId)).toEqual([fav.id]);
    expect(body.station.key).toBe("s:hiro");
    expect(body.station.label).toContain("ヒロ");
  });

  it("public: a favourite nobody has written about is not aired, and the answer is 409 empty", async () => {
    const owner = await createListener(env.DB);
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true });
    const fav = await insertItem(env.DB, itemDraft({ title: "owner-fav" }));
    await upsertHistory(env.DB, [{ listenerId: owner.id, itemId: fav.id, source: "manual", occurredAt: null, rank: 1 }]);
    const res = await postNext("s:hiro", await newSession());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "empty" });
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

describe("POST /stations/:key/next with the dial, first and a letter", () => {
  type Line = { type: string; bridge?: string; letterId?: string };
  type Full = { episode: { segments: { slot: string; itemId: string; lines: Line[] }[] } };
  const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;
  const send = (key: string, cookie: string, body: unknown) =>
    app.request(`/stations/${key}/next`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }, env);

  /** The listener's own work with a letter from someone else (near), and three far works. */
  async function seedMine(cookie: string) {
    await seedWorld();
    const me = idOf(cookie);
    const other = await createListener(env.DB);
    const near = await insertItem(env.DB, itemDraft({ title: "near", externalIds: { itunes: "900" } }));
    await upsertHistory(env.DB, [{ listenerId: me, itemId: near.id, source: "manual", occurredAt: null, rank: 1 }]);
    const mine = await insertLetter(env.DB, letterDraft(near.id, { listenerId: me, body: "私の手紙", bodyJa: "私の手紙" }));
    await insertLetter(env.DB, letterDraft(near.id, { listenerId: other.id, body: "近くの手紙", bodyJa: "近くの手紙" }));
    return { me, near, mine, other };
  }

  /** Every key of a JSON value, at any depth. */
  const keysOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

  it("picks by distance and never says how far: no vec, farness or distance anywhere in the answer", async () => {
    const cookie = await newSession();
    const { near } = await seedMine(cookie);
    const { results } = await env.DB.prepare("SELECT id FROM items ORDER BY title").all<{ id: string }>();
    for (const [i, r] of results.entries()) await setItemVec(env.DB, r.id, angled(r.id === near.id ? 0 : 0.3 + i * 0.2));
    expect((await getItemVecs(env.DB, results.map((r) => r.id))).size).toBe(results.length);
    for (const dial of [0, 0.5, 1]) {
      const res = await send("mine", cookie, { dial });
      expect(res.status).toBe(200);
      const text = await res.text();
      const keys = keysOf(JSON.parse(text)).map((k) => k.toLowerCase());
      for (const banned of ["vec", "farness", "distance", "percentile"]) expect(keys.filter((k) => k.includes(banned))).toEqual([]);
    }
  });

  it("first: one segment that opens with the open bridge", async () => {
    const cookie = await newSession();
    await seedMine(cookie);
    const res = await send("mine", cookie, { dial: 1, first: true });
    expect(res.status).toBe(200);
    const { episode } = (await res.json()) as Full;
    expect(episode.segments).toHaveLength(1);
    expect(episode.segments[0]!.slot).toBe("far");
    expect(episode.segments[0]!.lines[0]!.bridge).toBe("bridge.open");
  });

  it("not first: the slot bridge leads, and nothing closes", async () => {
    const cookie = await newSession();
    await seedMine(cookie);
    const { episode } = (await (await send("mine", cookie, { dial: 0, first: false })).json()) as Full;
    expect(episode.segments).toHaveLength(1);
    expect(episode.segments[0]!.lines[0]!.bridge).toBe(`bridge.${episode.segments[0]!.slot}`);
    expect(episode.segments.flatMap((s) => s.lines).some((l) => l.bridge === "bridge.close")).toBe(false);
  });

  it("a body without first does not open either", async () => {
    const cookie = await newSession();
    await seedMine(cookie);
    const { episode } = (await (await postNext("mine", cookie)).json()) as Full;
    expect(episode.segments[0]!.lines[0]!.bridge).not.toBe("bridge.open");
  });

  it("answers 400 for a dial out of range or a body of the wrong shape, and makes nothing", async () => {
    const cookie = await newSession();
    await seedMine(cookie);
    for (const body of [{ dial: 2 }, { dial: -0.1 }, { first: "yes" }, { letterId: "" }, { letterId: "x".repeat(101) }, [1]]) {
      const res = await send("mine", cookie, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad request" });
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM episodes").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("reads the letter the listener came for", async () => {
    const cookie = await newSession();
    await seedMine(cookie);
    const writer = await createListener(env.DB);
    const far = await insertItem(env.DB, itemDraft({ title: "asked", externalIds: { itunes: "901" } }));
    const asked = await insertLetter(env.DB, letterDraft(far.id, { listenerId: writer.id, body: "聴いてほしい", bodyJa: "聴いてほしい" }));
    const { episode } = (await (await send("mine", cookie, { dial: 0, first: true, letterId: asked.id })).json()) as Full;
    expect(episode.segments).toHaveLength(1);
    expect(episode.segments[0]!.itemId).toBe(far.id);
    expect(episode.segments[0]!.lines.some((l) => l.type === "letter" && l.letterId === asked.id)).toBe(true);
  });

  it("picks as usual when the letter is the listener's own, and ignores a letter on the world station", async () => {
    const cookie = await newSession();
    const { mine, near } = await seedMine(cookie);
    const { episode } = (await (await send("mine", cookie, { dial: 0, letterId: mine.id })).json()) as Full;
    expect(episode.segments).toHaveLength(1);
    expect(episode.segments[0]!.itemId).toBe(near.id);
    expect(episode.segments[0]!.lines.some((l) => l.letterId === mine.id)).toBe(false);
    const writer = await createListener(env.DB);
    const asked = await insertLetter(env.DB, letterDraft(near.id, { listenerId: writer.id, body: "別の手紙", bodyJa: "別の手紙" }));
    const world = (await (await send("world", cookie, { letterId: asked.id })).json()) as Full;
    expect(world.episode.segments[0]!.slot).toBe("far");
  });

  it("keeps a signed-in listener's dial from the request, and only theirs", async () => {
    const signed = await signedInSession();
    await seedMine(signed);
    expect((await send("mine", signed, { dial: 0.9 })).status).toBe(200);
    expect((await getListener(env.DB, idOf(signed)))!.dial).toBe(0.9);

    const anon = await newSession();
    await seedMine(anon);
    const before = (await getListener(env.DB, idOf(anon)))!.dial;
    expect((await send("mine", anon, { dial: 0.9 })).status).toBe(200);
    expect((await getListener(env.DB, idOf(anon)))!.dial).toBe(before);
  });
});

describe("rate limit", () => {
  it("counts the station post against the IP bucket, so a fresh cookie does not escape it", async () => {
    await seedWorld();
    const slow = { ...env, RATE_LIMIT_PER_MINUTE: "1" };
    const headers = { origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" };
    let last = 200;
    for (let n = 0; n < 8 && last !== 429; n++) last = (await postNext("world", await newSession(), slow, headers)).status;
    expect(last).toBe(429);
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

  it("resumes per station: world does not return a mine episode, and the reverse", async () => {
    await seedWorld();
    const cookie = await newSession();
    const listenerId = (await env.DB.prepare("SELECT id FROM listeners ORDER BY created_at DESC LIMIT 1").first<{ id: string }>())!.id;
    const it = await insertItem(env.DB, itemDraft({ title: "mine-1" }));
    await upsertHistory(env.DB, [{ listenerId, itemId: it.id, source: "manual", occurredAt: null, rank: 1 }]);
    const resume = (key: string) => app.request(`/stations/${key}.json`, { headers: { cookie } }, env);
    const world = (await (await postNext("world", cookie)).json()) as Body;
    expect((await resume("mine")).status).toBe(204);
    expect(((await (await resume("world")).json()) as Body).episode.id).toBe(world.episode.id);
    const mine = (await (await postNext("mine", cookie)).json()) as Body;
    expect(((await (await resume("mine")).json()) as Body).episode.id).toBe(mine.episode.id);
    expect(((await (await resume("world")).json()) as Body).episode.id).toBe(world.episode.id);
  });

  it("with ?id= returns that episode, not the latest, when it is the listener's own on this station", async () => {
    await seedWorld();
    const cookie = await newSession();
    const first = (await (await postNext("world", cookie)).json()) as Body;
    const second = (await (await postNext("world", cookie)).json()) as Body;
    const latest = await app.request("/stations/world.json", { headers: { cookie } }, env);
    expect(((await latest.json()) as Body).episode.id).toBe(second.episode.id);
    const res = await app.request(`/stations/world.json?id=${first.episode.id}`, { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).episode.id).toBe(first.episode.id);
  });

  it("with ?id= answers 204 for another listener's episode, an episode of another station, or an unknown id", async () => {
    await seedWorld();
    const cookie = await newSession();
    const listenerId = (await env.DB.prepare("SELECT id FROM listeners ORDER BY created_at DESC LIMIT 1").first<{ id: string }>())!.id;
    const it = await insertItem(env.DB, itemDraft({ title: "mine-1" }));
    await upsertHistory(env.DB, [{ listenerId, itemId: it.id, source: "manual", occurredAt: null, rank: 1 }]);
    const world = (await (await postNext("world", cookie)).json()) as Body;
    const mine = (await (await postNext("mine", cookie)).json()) as Body;
    const get = (key: string, id: string, ck = cookie) => app.request(`/stations/${key}.json?id=${id}`, { headers: { cookie: ck } }, env);
    expect((await get("world", world.episode.id)).status).toBe(200);
    expect((await get("world", mine.episode.id)).status).toBe(204);
    expect((await get("mine", world.episode.id)).status).toBe(204);
    expect((await get("world", "nope")).status).toBe(204);
    expect((await get("world", world.episode.id, await newSession())).status).toBe(204);
  });

  it("does not resume an episode of the other language after the listener switches", async () => {
    await seedWorld();
    const cookie = await newSession();
    const listenerId = (await env.DB.prepare("SELECT id FROM listeners ORDER BY created_at DESC LIMIT 1").first<{ id: string }>())!.id;
    const ja = (await (await postNext("world", cookie)).json()) as Body;
    await env.DB.prepare("UPDATE listeners SET lang = 'en' WHERE id = ?").bind(listenerId).run();
    expect((await app.request("/stations/world.json", { headers: { cookie } }, env)).status).toBe(204);
    expect((await app.request(`/stations/world.json?id=${ja.episode.id}`, { headers: { cookie } }, env)).status).toBe(204);
    const en = (await (await postNext("world", cookie)).json()) as Body;
    expect(((await (await app.request("/stations/world.json", { headers: { cookie } }, env)).json()) as Body).episode.id).toBe(en.episode.id);
  });

  it("does not show another listener's episode, and 404s a bad key", async () => {
    await seedWorld();
    await postNext("world", await newSession());
    const stranger = await newSession();
    expect((await app.request("/stations/world.json", { headers: { cookie: stranger } }, env)).status).toBe(204);
    expect((await app.request("/stations/bogus.json", { headers: { cookie: stranger } }, env)).status).toBe(404);
  });
});

describe("GET /stations/:key (page)", () => {
  const page = (key: string, cookie: string) => app.request(`/stations/${key}`, { headers: { cookie } }, env);

  it("world: the mount point carries the urls and the player script and strings come with it", async () => {
    const res = await page("world", await newSession());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="station"');
    expect(html).toContain('data-next-url="/stations/world/next"');
    expect(html).toContain('data-resume-url="/stations/world.json"');
    expect(html).toContain('data-station-key="world"');
    expect(html).toContain('data-grow="0"');
    expect(html).toMatch(/<script type="module" src="\/(assets\/station\.js|src\/client\/station\.tsx)">/);
    const i18n = JSON.parse(html.match(/<script type="application\/json" id="station-i18n">(.*?)<\/script>/s)![1]!) as Record<string, string>;
    expect(i18n["station.onOff"]).toBe("ラジオをつける / 止める");
    expect(i18n["letter.showOriginal"]).toBeDefined();
    expect(i18n["kind.music"]).toBeDefined();
    expect(i18n["out.spotify"]).toBeDefined();
    expect(i18n["home.start"]).toBeUndefined();
    expect(html).toContain("<title>Dococa FM</title>");
  });

  it("404s an unknown key, an unknown slug and a station that is not public", async () => {
    const cookie = await newSession();
    expect((await page("nonsense", cookie)).status).toBe(404);
    expect((await page("s:nobody", cookie)).status).toBe(404);
    const owner = await createListener(env.DB);
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: false });
    expect((await page("s:hiro", cookie)).status).toBe(404);
  });

  it("a public station is titled with its owner's name", async () => {
    const owner = await createListener(env.DB, { radioName: "ヒロ" });
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true });
    const html = await (await page("s:hiro", await newSession())).text();
    expect(html).toContain('data-next-url="/stations/s:hiro/next"');
    expect(html).toContain('data-listens-url="/listens"');
    expect(html).toContain("ヒロ");
  });

  it("mine with no history asks the player to show how to start; with history it does not", async () => {
    const cookie = await newSession();
    expect(await (await page("mine", cookie)).text()).toContain('data-grow="1"');
    const listenerId = (await env.DB.prepare("SELECT id FROM listeners ORDER BY created_at DESC LIMIT 1").first<{ id: string }>())!.id;
    const it = await insertItem(env.DB, itemDraft({ title: "mine-1" }));
    await upsertHistory(env.DB, [{ listenerId, itemId: it.id, source: "manual", occurredAt: null, rank: 1 }]);
    expect(await (await page("mine", cookie)).text()).toContain('data-grow="0"');
  });

  it("a letter link plays for a brand-new listener: the switch works, the first next reads it, the next one still answers", async () => {
    await seedWorld();
    const writer = await createListener(env.DB);
    const item = await insertItem(env.DB, itemDraft({ title: "asked", externalIds: { itunes: "950" } }));
    const asked = await insertLetter(env.DB, letterDraft(item.id, { listenerId: writer.id, body: "聴いてほしい", bodyJa: "聴いてほしい" }));
    const cookie = await newSession();
    const html = await (await page(`mine?letter=${asked.id}`, cookie)).text();
    expect(html).toContain('data-grow="0"');
    expect(html).toContain(`data-letter="${asked.id}"`);
    const send = (body: unknown) =>
      app.request("/stations/mine/next", { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    const first = await send({ dial: 0.5, first: true, letterId: asked.id });
    expect(first.status).toBe(200);
    const one = (await first.json()) as { episode: { segments: { itemId: string; lines: { type: string; letterId?: string }[] }[] } };
    expect(one.episode.segments[0]!.itemId).toBe(item.id);
    expect(one.episode.segments[0]!.lines.some((l) => l.type === "letter" && l.letterId === asked.id)).toBe(true);
    const second = await send({ dial: 0.5, first: false });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Body).episode.segments).toHaveLength(1);
  });

  it("mine carries a letter asked for in the url; other stations and odd values do not", async () => {
    const cookie = await newSession();
    expect(await (await page("mine?letter=abc-123", cookie)).text()).toContain('data-letter="abc-123"');
    expect(await (await page("mine", cookie)).text()).not.toContain("data-letter");
    expect(await (await page(`mine?letter=${"x".repeat(101)}`, cookie)).text()).not.toContain("data-letter");
    expect(await (await page("world?letter=abc-123", cookie)).text()).not.toContain("data-letter");
  });

  it("a public station page carries og tags, titled with the owner's radio name, never the google display name", async () => {
    const owner = await createListener(env.DB, { radioName: "ちくわ" });
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true, displayName: "Hiro Sasaki" });
    const html = await (await page("s:hiro", await newSession())).text();
    expect(html).toContain('<meta property="og:title" content="ちくわさんのラジオ"');
    expect(html).toContain('<meta property="og:description" content="世界のどこかにいる誰かの好きなものが聴こえてくるラジオ"');
    expect(html).toContain('<meta property="og:url" content="http://127.0.0.1:5173/stations/s:hiro"');
    expect(html).toContain("<title>ちくわさんのラジオ | Dococa FM</title>");
    expect(html).not.toContain("Hiro");
  });

  it("turning the station off makes the page a 404 again", async () => {
    const owner = await createListener(env.DB);
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true });
    expect((await page("s:hiro", await newSession())).status).toBe(200);
    await updateListener(env.DB, owner.id, { stationPublic: false });
    expect((await page("s:hiro", await newSession())).status).toBe(404);
  });

  it("a public station with no favourites still renders, and its next answers 409 empty", async () => {
    const owner = await createListener(env.DB);
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true });
    const cookie = await newSession();
    expect((await page("s:hiro", cookie)).status).toBe(200);
    const res = await postNext("s:hiro", cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "empty" });
  });

  it("an owner without a radio name is anonymous on the page, not named after their google account", async () => {
    const owner = await createListener(env.DB);
    await updateListener(env.DB, owner.id, { stationSlug: "hiro", stationPublic: true, displayName: "Hiro Sasaki" });
    const html = await (await page("s:hiro", await newSession())).text();
    expect(html).toContain("名無しのリスナーさんのラジオ");
    expect(html).not.toContain("Hiro");
  });
});
