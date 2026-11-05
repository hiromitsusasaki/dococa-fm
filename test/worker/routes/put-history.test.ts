import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../../src/worker/auth/crypto";
import { listFavorites, upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { updateListener } from "../../../src/worker/db/listeners";
import { t } from "../../../src/worker/i18n/t";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "../db/helpers";
import { get, newSession, postForm, signedInSession } from "./helpers";

let create: ReturnType<typeof stubAnthropic>;
beforeEach(async () => {
  await resetDb(env.DB);
  (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "sk-test";
  create = stubAnthropic();
  create.mockResolvedValue(toolUse("ask", { questions: ["誰かと一緒でしたか？"] }));
});
afterEach(() => {
  (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function listenerId(cookie: string): Promise<string> {
  const sid = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
  return sid;
}

describe("GET /put with a history", () => {
  it("lists the history with links to put each one, and offers to connect Spotify", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: await listenerId(cookie), itemId: item.id, source: "spotify", occurredAt: null, rank: null }]);
    const html = await (await get("/put", cookie)).text();
    expect(html).toContain(t("put.fromHistory"));
    expect(html).toContain(`/put?itemId=${item.id}`);
    expect(html).toContain("Blue in Green");
    expect(html).toContain("Miles Davis");
    expect(html).toContain('href="/auth/spotify"');
    expect(html).toContain(t("put.connectSpotify"));
  });

  it("hides the history section and the connect link when there is nothing to show", async () => {
    const cookie = await signedInSession();
    const id = await listenerId(cookie);
    await updateListener(env.DB, id, { spotifyRefreshToken: await encryptSecret("rt", env.SESSION_SECRET) });
    const html = await (await get("/put", cookie)).text();
    expect(html).not.toContain(t("put.fromHistory"));
    expect(html).not.toContain(t("put.connectSpotify"));
  });

  it("shows the DJ's questions for an item in the history", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: await listenerId(cookie), itemId: item.id, source: "spotify", occurredAt: null, rank: null }]);
    const html = await (await get(`/put?itemId=${item.id}`, cookie)).text();
    expect(html).toContain(t("put.questions"));
    expect(html).toContain("誰かと一緒でしたか？");
    expect(html.indexOf("誰かと一緒でしたか？")).toBeLessThan(html.indexOf("<textarea"));
  });

  it("asks nothing for an item that is not in the history", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    const html = await (await get(`/put?itemId=${item.id}`, cookie)).text();
    expect(html).not.toContain(t("put.questions"));
    expect(create).not.toHaveBeenCalled();
  });

  it("shows the imported notice without a number", async () => {
    const html = await (await get("/put?imported=1", await signedInSession())).text();
    expect(html).toContain(t("put.imported"));
    expect(html).not.toMatch(/\d+\s*(件|曲)/);
  });
});

describe("imported candidates and /put/register", () => {
  it("shows the ranked group before the recent group, favourites first, with no rank numbers", async () => {
    const cookie = await signedInSession();
    const id = await listenerId(cookie);
    const [fav, a, b, r] = await Promise.all(["Fav", "Alpha", "Beta", "Recent"].map((title) => insertItem(env.DB, itemDraft({ title, externalIds: { k: title } }))));
    await upsertHistory(env.DB, [
      { listenerId: id, itemId: fav!.id, source: "manual", occurredAt: null, rank: null },
      { listenerId: id, itemId: b!.id, source: "spotify", occurredAt: null, rank: 2 },
      { listenerId: id, itemId: a!.id, source: "spotify", occurredAt: null, rank: 1 },
      { listenerId: id, itemId: r!.id, source: "spotify", occurredAt: "2026-10-01T00:00:00.000Z", rank: null },
    ]);
    const html = await (await get("/put", cookie)).text();
    const at = (s: string) => html.indexOf(s);
    expect(at(t("put.favorites"))).toBeLessThan(at(t("put.imported.top")));
    expect(at(t("put.imported.top"))).toBeLessThan(at("Alpha"));
    expect(at("Alpha")).toBeLessThan(at("Beta"));
    expect(at("Beta")).toBeLessThan(at(t("put.imported.recent")));
    expect(at(t("put.imported.recent"))).toBeLessThan(at("Recent"));
    expect(html).toContain(t("put.register"));
    expect(html).not.toMatch(/\d+\s*位/);
    expect(html.match(/action="\/put\/register"/g)).toHaveLength(3);
  });

  it("registers an imported item as a favourite and goes on to the letter screen", async () => {
    const cookie = await signedInSession();
    const id = await listenerId(cookie);
    const item = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: id, itemId: item.id, source: "spotify", occurredAt: null, rank: 3 }]);
    expect(await listFavorites(env.DB, id, 10)).toHaveLength(0);
    const res = await postForm("/put/register", cookie, { itemId: item.id });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/put?itemId=${item.id}`);
    const favs = await listFavorites(env.DB, id, 10);
    expect(favs.map((f) => [f.itemId, f.rank])).toEqual([[item.id, 3]]);
  });

  it("404s for an item that is not in this listener's history", async () => {
    const cookie = await signedInSession();
    const item = await insertItem(env.DB, itemDraft());
    expect((await postForm("/put/register", cookie, { itemId: item.id })).status).toBe(404);
  });

  it("sends an anonymous visitor to sign in without writing anything", async () => {
    const cookie = await newSession();
    const id = await listenerId(cookie);
    const item = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: id, itemId: item.id, source: "spotify", occurredAt: null, rank: null }]);
    const res = await postForm("/put/register", cookie, { itemId: item.id });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/auth/google");
    expect(await listFavorites(env.DB, id, 10)).toHaveLength(0);
  });
});

describe("GET /settings spotify section", () => {
  it("shows not connected, the connect link and the dev-mode note", async () => {
    const html = await (await get("/settings", await signedInSession())).text();
    expect(html).toContain(t("settings.spotifyNotConnected"));
    expect(html).toContain('href="/auth/spotify"');
    expect(html).toContain(t("settings.spotifyDevMode"));
  });

  it("shows the failed notice after a failed import", async () => {
    const html = await (await get("/settings?spotify=failed", await signedInSession())).text();
    expect(html).toContain(t("settings.spotifyFailed"));
    expect(await (await get("/settings", await signedInSession())).text()).not.toContain(t("settings.spotifyFailed"));
  });

  it("shows connected once a token is stored", async () => {
    const cookie = await signedInSession();
    await updateListener(env.DB, await listenerId(cookie), { spotifyRefreshToken: await encryptSecret("rt", env.SESSION_SECRET) });
    const html = await (await get("/settings", cookie)).text();
    expect(html).toContain(t("settings.spotifyConnected"));
    expect(html).not.toContain(t("settings.spotifyNotConnected"));
  });
});
