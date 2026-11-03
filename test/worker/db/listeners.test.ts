import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createListener,
  getListener,
  getListenerByMcpToken,
  updateListener,
} from "../../../src/worker/db/listeners";
import { resetDb } from "./helpers";

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
});
