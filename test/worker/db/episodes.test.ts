import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { countEpisodesToday, getEpisode, insertEpisode, jstDayStartIso, listEpisodes } from "../../../src/worker/db/episodes";
import { createListener } from "../../../src/worker/db/listeners";
import { resetDb } from "../../helpers/db";
import type { Episode } from "../../../src/worker/types";

const report = { verbatim: true, sources: true, topical: true, pii: true, details: [] };
const draft = (listenerId: string, createdAt?: string, verified = true) => ({
  listenerId,
  segments: [{ itemId: "i", slot: "near" as const, lines: [{ type: "dj" as const, text: "こんばんは" }] }],
  verified,
  report,
  ...(createdAt ? { createdAt } : {}),
});

describe("episodes", () => {
  beforeEach(() => resetDb(env.DB));

  it("insertEpisode then getEpisode round-trips JSON and boolean", async () => {
    const me = await createListener(env.DB);
    const e = await insertEpisode(env.DB, draft(me.id, undefined, false));
    const got = await getEpisode(env.DB, e.id);
    expect(got).toEqual(e);
    expect(got?.verified).toBe(false);
    expect(got?.segments[0]?.lines[0]).toEqual({ type: "dj", text: "こんばんは" });
    expect(await getEpisode(env.DB, "nope")).toBeNull();
  });

  it("insertEpisode stores cloudTts (default false)", async () => {
    const me = await createListener(env.DB);
    expect((await getEpisode(env.DB, (await insertEpisode(env.DB, draft(me.id))).id))?.cloudTts).toBe(false);
    const on = await insertEpisode(env.DB, { ...draft(me.id), cloudTts: true });
    expect((await getEpisode(env.DB, on.id))?.cloudTts).toBe(true);
  });

  it("insertEpisode stores the episode's language (default ja)", async () => {
    const me = await createListener(env.DB);
    expect((await getEpisode(env.DB, (await insertEpisode(env.DB, draft(me.id))).id))?.lang).toBe("ja");
    const en = await insertEpisode(env.DB, { ...draft(me.id), lang: "en" });
    expect(en.lang).toBe("en");
    expect((await getEpisode(env.DB, en.id))?.lang).toBe("en");
  });

  it("insertEpisode keeps a given id and mints one otherwise", async () => {
    const me = await createListener(env.DB);
    const given = await insertEpisode(env.DB, { ...draft(me.id), id: "11111111-1111-1111-1111-111111111111" });
    expect(given.id).toBe("11111111-1111-1111-1111-111111111111");
    expect((await getEpisode(env.DB, given.id))?.id).toBe(given.id);
    expect((await insertEpisode(env.DB, draft(me.id))).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("listEpisodes returns newest first with a limit", async () => {
    const me = await createListener(env.DB);
    const other = await createListener(env.DB);
    const a = await insertEpisode(env.DB, draft(me.id, "2026-01-01T00:00:00.000Z"));
    const b = await insertEpisode(env.DB, draft(me.id, "2026-01-02T00:00:00.000Z"));
    await insertEpisode(env.DB, draft(other.id, "2026-01-03T00:00:00.000Z"));
    expect((await listEpisodes(env.DB, me.id, 10)).map((e: Episode) => e.id)).toEqual([b.id, a.id]);
    expect(await listEpisodes(env.DB, me.id, 1)).toHaveLength(1);
  });

  it("jstDayStartIso returns the UTC instant of JST midnight", () => {
    expect(jstDayStartIso(new Date("2026-11-03T05:00:00.000Z"))).toBe("2026-11-02T15:00:00.000Z");
    expect(jstDayStartIso(new Date("2026-11-02T14:59:59.000Z"))).toBe("2026-11-01T15:00:00.000Z");
    expect(jstDayStartIso(new Date("2026-11-02T15:00:00.000Z"))).toBe("2026-11-02T15:00:00.000Z");
  });

  it("countEpisodesToday counts only the current JST day", async () => {
    const me = await createListener(env.DB);
    const other = await createListener(env.DB);
    // now = 2026-11-03 12:00 JST. JST day starts 2026-11-02T15:00Z.
    const now = new Date("2026-11-03T03:00:00.000Z");
    await insertEpisode(env.DB, draft(me.id, "2026-11-02T15:30:00.000Z")); // JST 00:30 today
    await insertEpisode(env.DB, draft(me.id, "2026-11-03T02:00:00.000Z")); // JST 11:00 today
    await insertEpisode(env.DB, draft(me.id, "2026-11-02T14:30:00.000Z")); // JST 23:30 yesterday
    await insertEpisode(env.DB, draft(other.id, "2026-11-03T02:00:00.000Z"));
    expect(await countEpisodesToday(env.DB, me.id, now)).toBe(2);
  });
});
