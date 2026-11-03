import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimCloudTts,
  createListener,
  getListener,
  getListenerByMcpToken,
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

  it("claimCloudTts succeeds exactly once", async () => {
    const l = await createListener(env.DB);
    expect(await claimCloudTts(env.DB, l.id)).toBe(true);
    expect(await claimCloudTts(env.DB, l.id)).toBe(false);
    expect((await getListener(env.DB, l.id))?.cloudTtsUsed).toBe(true);
  });
});
