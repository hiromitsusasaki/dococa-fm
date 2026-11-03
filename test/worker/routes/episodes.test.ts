import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import { getEpisode, listEpisodes } from "../../../src/worker/db/episodes";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import type { Episode } from "../../../src/worker/types";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, newSession, postForm } from "./helpers";

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;

/** A listener with a played item and a letter of their own, plus another person's letters on far items. */
async function seed(cookie: string) {
  const me = idOf(cookie);
  const other = await createListener(env.DB);
  const near = await insertItem(env.DB, itemDraft({ title: "手元の曲" }));
  const far1 = await insertItem(env.DB, itemDraft({ title: "遠い国の歌", externalIds: { itunes: "2" } }));
  const far2 = await insertItem(env.DB, itemDraft({ title: "もうひとつの歌", externalIds: { itunes: "3" } }));
  await upsertHistory(env.DB, [{ listenerId: me, itemId: near.id, source: "manual", occurredAt: null }]);
  const mine = await insertLetter(env.DB, letterDraft(near.id, { listenerId: me, body: "私の一通", bodyJa: "私の一通" }));
  for (const it of [near, far1, far2]) {
    await insertLetter(env.DB, letterDraft(it.id, { listenerId: other.id, radioName: "しずく", place: "松本", body: `${it.title}への手紙`, bodyJa: `${it.title}への手紙` }));
  }
  return { me, near, far1, far2, mine };
}

const post = (path: string, cookie: string, e: object = env) =>
  app.request(path, { method: "POST", headers: { cookie } }, e);

const locationId = (res: Response) => res.headers.get("location")!.replace("/episodes/", "");

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await resetDb(env.DB);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /episodes", () => {
  it("builds, stores under the minted id and redirects to the player", async () => {
    const cookie = await newSession();
    await seed(cookie);
    const res = await postForm("/episodes", cookie, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/episodes\/[0-9a-f-]{36}$/);
    const rows = await listEpisodes(env.DB, idOf(cookie), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(locationId(res));
    expect(rows[0]!.verified).toBe(true);
  });

  it("answers 429 with the limit page once today's episodes reach the limit", async () => {
    const cookie = await newSession();
    await seed(cookie);
    const limited = { ...env, EPISODE_DAILY_LIMIT: "1" };
    expect((await post("/episodes", cookie, limited)).status).toBe(303);
    const second = await post("/episodes", cookie, limited);
    expect(second.status).toBe(429);
    expect(await second.text()).toContain("今日の番組はここまで。また明日");
    expect(await listEpisodes(env.DB, idOf(cookie), 10)).toHaveLength(1);
  });

  it("falls back to 10 when the limit is not a positive number", async () => {
    const cookie = await newSession();
    await seed(cookie);
    expect((await post("/episodes", cookie, { ...env, EPISODE_DAILY_LIMIT: "abc" })).status).toBe(303);
    expect((await post("/episodes", cookie, { ...env, EPISODE_DAILY_LIMIT: "0" })).status).toBe(303);
  });

  it("answers 503 and stores nothing when the episode cannot be verified", async () => {
    const cookie = await newSession();
    const { me, near, mine } = await seed(cookie);
    // A reaction whose radio name is the listener's own id: the fixed line would read the account aloud.
    await insertLetter(env.DB, letterDraft(near.id, { kind: "watashimo", listenerId: null, radioName: me, place: "", parentLetterId: mine.id, body: "私も", bodyJa: "私も" }));
    const res = await postForm("/episodes", cookie, {});
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("番組を作れませんでした。少し待ってもう一度");
    expect(await listEpisodes(env.DB, me, 10)).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("EpisodeUnverifiedError"));
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(me);
  });
});

describe("GET /episodes/:id", () => {
  async function make() {
    const cookie = await newSession();
    const s = await seed(cookie);
    const id = locationId(await postForm("/episodes", cookie, {}));
    return { cookie, id, ...s };
  }

  it("renders the player with the items in program order and no counts", async () => {
    const { cookie, id } = await make();
    const html = await (await get(`/episodes/${id}`, cookie)).text();
    const ep = (await getEpisode(env.DB, id))!;
    expect(html).toContain('id="player"');
    expect(html).toContain(`data-episode-id="${id}"`);
    expect(html).toContain(`data-next-url="/episodes/${id}/next"`);
    expect(html).toContain('data-dial="0.3"');
    expect(html).toContain('id="episode-json"');
    expect(html).toContain("しずく");
    expect(html).toContain("松本");
    expect(html).toMatch(/近く|隣|遠く/);
    expect(html).not.toMatch(/\d+\s*(件|人|位)/);
    const titles = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
    const expected = await Promise.all(ep.segments.map(async (s) => (await env.DB.prepare("SELECT title FROM items WHERE id = ?").bind(s.itemId).first<{ title: string }>())!.title));
    expect(titles).toEqual(expected);
  });

  it("embeds the episode as html-safe json that round-trips", async () => {
    const { cookie, id, me } = await make();
    const ep = (await getEpisode(env.DB, id))!;
    ep.segments[0]!.lines.push({ type: "dj", text: "終わり</script><script>alert(1)</script><!-- x" });
    await env.DB.prepare("UPDATE episodes SET segments = ? WHERE id = ?").bind(JSON.stringify(ep.segments), id).run();
    const html = await (await get(`/episodes/${id}`, cookie)).text();
    const m = html.match(/<script type="application\/json" id="episode-json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const body = m![1]!;
    expect(body).not.toContain("</");
    expect(body).not.toContain("<!--");
    expect(html).not.toContain("<script>alert(1)");
    const parsed = JSON.parse(body) as { id: string; segments: Episode["segments"]; items: Record<string, unknown> } & Record<string, unknown>;
    expect(parsed.id).toBe(ep.id);
    expect(parsed.segments).toEqual(ep.segments);
    // The page carries only what the player shows: no listener id, no verification report.
    expect(Object.keys(parsed).sort()).toEqual(["id", "items", "segments"]);
    expect(html).not.toContain(me);
    expect(Object.keys(parsed.items).sort()).toEqual(ep.segments.map((s) => s.itemId).sort());
  });

  it("projects each item to title, creator, image and http outlinks, and ships the player strings", async () => {
    const { cookie, id, near } = await make();
    await env.DB.prepare("UPDATE items SET out_links = ? WHERE id = ?").bind(JSON.stringify({ spotify: "https://open.spotify.com/x", youtube: "javascript:alert(1)" }), near.id).run();
    const html = await (await get(`/episodes/${id}`, cookie)).text();
    const items = JSON.parse(html.match(/id="episode-json">([\s\S]*?)<\/script>/)![1]!).items;
    expect(Object.keys(items[near.id]).sort()).toEqual(["creator", "imageUrl", "outLinks", "title"]);
    expect(items[near.id].title).toBe("手元の曲");
    expect(items[near.id].outLinks).toEqual({ spotify: "https://open.spotify.com/x" });
    const strings = JSON.parse(html.match(/id="player-i18n">([\s\S]*?)<\/script>/)![1]!);
    expect(strings["player.play"]).toBe("再生");
    expect(strings["out.spotify"]).toBe("Spotify で聴く");
    expect(strings["letter.who"]).toBe("{name}さん");
    expect(strings["listener.anonymous"]).toBe("名無しのリスナー");
  });

  it("serves the episode as json", async () => {
    const { cookie, id } = await make();
    const res = await get(`/episodes/${id}.json`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as Episode).id).toBe(id);
  });

  it("is 404 for another listener's episode on every route", async () => {
    const { id } = await make();
    const stranger = await newSession();
    expect((await get(`/episodes/${id}`, stranger)).status).toBe(404);
    expect((await get(`/episodes/${id}.json`, stranger)).status).toBe(404);
    expect((await post(`/episodes/${id}/next`, stranger)).status).toBe(404);
    expect((await get(`/episodes/missing`, stranger)).status).toBe(404);
  });
});

describe("POST /episodes/:id/next", () => {
  it("builds the next episode and returns its id", async () => {
    const cookie = await newSession();
    await seed(cookie);
    const first = locationId(await postForm("/episodes", cookie, {}));
    const res = await post(`/episodes/${first}/next`, cookie);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).not.toBe(first);
    expect(await getEpisode(env.DB, id)).not.toBeNull();
  });

  it("answers 429 json at the limit and 503 json when unverifiable", async () => {
    const cookie = await newSession();
    const { me, near, mine } = await seed(cookie);
    const first = locationId(await postForm("/episodes", cookie, {}));
    const limited = await post(`/episodes/${first}/next`, cookie, { ...env, EPISODE_DAILY_LIMIT: "1" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "limit" });
    await insertLetter(env.DB, letterDraft(near.id, { kind: "watashimo", listenerId: null, radioName: me, place: "", parentLetterId: mine.id, body: "私も", bodyJa: "私も" }));
    const broken = await post(`/episodes/${first}/next`, cookie);
    expect(broken.status).toBe(503);
    expect(await broken.json()).toEqual({ error: "unavailable" });
  });
});

describe("GET /episodes", () => {
  it("lists the listener's episodes by JST date and first item title, without counts", async () => {
    const cookie = await newSession();
    await seed(cookie);
    const id = locationId(await postForm("/episodes", cookie, {}));
    const html = await (await get("/episodes", cookie)).text();
    expect(html).toContain(`href="/episodes/${id}"`);
    expect(html).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).not.toMatch(/\d+\s*(件|人|位)/);
    const stranger = await newSession();
    expect(await (await get("/episodes", stranger)).text()).not.toContain(id);
  });
});
