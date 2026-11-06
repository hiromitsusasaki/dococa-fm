import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createListener,
  getListener,
  getListenerByGoogleSub,
  getListenerByMcpToken,
  getListenerBySlug,
  updateListener,
} from "../../../src/worker/db/listeners";
import { resetDb } from "../../helpers/db";

describe("listeners", () => {
  beforeEach(() => resetDb(env.DB));

  it("createListener applies defaults", async () => {
    const l = await createListener(env.DB);
    expect(l).toMatchObject({
      radioName: "",
      place: "",
      voice: "",
      dial: 0.3,
      lang: "ja",
      spotifyRefreshToken: null,
      cloudTtsUsed: false,
    });
    expect(l.mcpToken).toMatch(/^[0-9a-f]{48}$/);
    expect(await getListener(env.DB, l.id)).toEqual(l);
  });

  it("getListenerByMcpToken finds the listener", async () => {
    const l = await createListener(env.DB);
    await createListener(env.DB);
    expect((await getListenerByMcpToken(env.DB, l.mcpToken))?.id).toBe(l.id);
    expect(await getListenerByMcpToken(env.DB, "nope")).toBeNull();
  });

  it("updateListener patches only given fields", async () => {
    const l = await createListener(env.DB);
    const u = await updateListener(env.DB, l.id, { radioName: "夜更かし", dial: 0.7, spotifyRefreshToken: "tok" });
    expect(u).toMatchObject({ radioName: "夜更かし", dial: 0.7, spotifyRefreshToken: "tok", place: "", mcpToken: l.mcpToken });
    expect(await getListener(env.DB, l.id)).toEqual(u);
  });

  it("updateListener with an empty patch returns the listener unchanged", async () => {
    const l = await createListener(env.DB);
    expect(await updateListener(env.DB, l.id, {})).toEqual(l);
  });

  it("updateListener writes cloudTtsUsed as a boolean", async () => {
    const l = await createListener(env.DB);
    expect((await updateListener(env.DB, l.id, { cloudTtsUsed: true }))?.cloudTtsUsed).toBe(true);
    expect((await updateListener(env.DB, l.id, { cloudTtsUsed: false }))?.cloudTtsUsed).toBe(false);
  });

  it("createListener starts without a google identity or a public station", async () => {
    const l = await createListener(env.DB);
    expect(l).toMatchObject({ googleSub: null, displayName: "", stationPublic: false, stationSlug: null });
  });

  it("getListenerByGoogleSub finds the listener who signed in with that account", async () => {
    const l = await createListener(env.DB);
    await createListener(env.DB);
    await updateListener(env.DB, l.id, { googleSub: "g1", displayName: "Hiro" });
    expect(await getListenerByGoogleSub(env.DB, "g1")).toMatchObject({ id: l.id, googleSub: "g1", displayName: "Hiro" });
    expect(await getListenerByGoogleSub(env.DB, "g2")).toBeNull();
  });

  it("getListenerBySlug returns only public stations", async () => {
    const l = await createListener(env.DB);
    await updateListener(env.DB, l.id, { stationSlug: "hiro", stationPublic: true });
    expect((await getListenerBySlug(env.DB, "hiro"))?.id).toBe(l.id);
    expect((await getListener(env.DB, l.id))?.stationPublic).toBe(true);
    await updateListener(env.DB, l.id, { stationPublic: false });
    expect(await getListenerBySlug(env.DB, "hiro")).toBeNull();
  });

  it("a google account or a slug belongs to one listener", async () => {
    const a = await createListener(env.DB);
    const b = await createListener(env.DB);
    await updateListener(env.DB, a.id, { googleSub: "g1", stationSlug: "hiro" });
    await expect(updateListener(env.DB, b.id, { googleSub: "g1" })).rejects.toThrow(/UNIQUE/);
    await expect(updateListener(env.DB, b.id, { stationSlug: "hiro" })).rejects.toThrow(/UNIQUE/);
  });

  it("many listeners may have no google account or slug", async () => {
    await createListener(env.DB);
    await expect(createListener(env.DB)).resolves.toBeDefined();
  });

  it("lang can be en", async () => {
    const l = await createListener(env.DB);
    expect((await updateListener(env.DB, l.id, { lang: "en" }))?.lang).toBe("en");
  });
});
