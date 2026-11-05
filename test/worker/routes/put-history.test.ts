import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../../src/worker/auth/crypto";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { updateListener } from "../../../src/worker/db/listeners";
import { t } from "../../../src/worker/i18n/t";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft } from "../db/helpers";
import { get, newSession } from "./helpers";

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
    const cookie = await newSession();
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
    const cookie = await newSession();
    const id = await listenerId(cookie);
    await updateListener(env.DB, id, { spotifyRefreshToken: await encryptSecret("rt", env.SESSION_SECRET) });
    const html = await (await get("/put", cookie)).text();
    expect(html).not.toContain(t("put.fromHistory"));
    expect(html).not.toContain(t("put.connectSpotify"));
  });

  it("shows the DJ's questions for an item in the history", async () => {
    const cookie = await newSession();
    const item = await insertItem(env.DB, itemDraft());
    await upsertHistory(env.DB, [{ listenerId: await listenerId(cookie), itemId: item.id, source: "spotify", occurredAt: null, rank: null }]);
    const html = await (await get(`/put?itemId=${item.id}`, cookie)).text();
    expect(html).toContain(t("put.questions"));
    expect(html).toContain("誰かと一緒でしたか？");
    expect(html.indexOf("誰かと一緒でしたか？")).toBeLessThan(html.indexOf("<textarea"));
  });

  it("asks nothing for an item that is not in the history", async () => {
    const cookie = await newSession();
    const item = await insertItem(env.DB, itemDraft());
    const html = await (await get(`/put?itemId=${item.id}`, cookie)).text();
    expect(html).not.toContain(t("put.questions"));
    expect(create).not.toHaveBeenCalled();
  });

  it("shows the imported notice without a number", async () => {
    const html = await (await get("/put?imported=1", await newSession())).text();
    expect(html).toContain(t("put.imported"));
    expect(html).not.toMatch(/\d+\s*(件|曲)/);
  });
});

describe("GET /settings spotify section", () => {
  it("shows not connected, the connect link and the dev-mode note", async () => {
    const html = await (await get("/settings", await newSession())).text();
    expect(html).toContain(t("settings.spotifyNotConnected"));
    expect(html).toContain('href="/auth/spotify"');
    expect(html).toContain(t("settings.spotifyDevMode"));
  });

  it("shows the failed notice after a failed import", async () => {
    const html = await (await get("/settings?spotify=failed", await newSession())).text();
    expect(html).toContain(t("settings.spotifyFailed"));
    expect(await (await get("/settings", await newSession())).text()).not.toContain(t("settings.spotifyFailed"));
  });

  it("shows connected once a token is stored", async () => {
    const cookie = await newSession();
    await updateListener(env.DB, await listenerId(cookie), { spotifyRefreshToken: await encryptSecret("rt", env.SESSION_SECRET) });
    const html = await (await get("/settings", cookie)).text();
    expect(html).toContain(t("settings.spotifyConnected"));
    expect(html).not.toContain(t("settings.spotifyNotConnected"));
  });
});
