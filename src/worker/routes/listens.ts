import { Hono } from "hono";
import { z } from "zod";
import type { Variables } from "../auth/session";
import { getVerifiedEpisode } from "../db/episodes";
import { recordListen } from "../db/listens";
import type { Env } from "../env";
import { loadPublicEpisode } from "../program/stored";

export const listens = new Hono<{ Bindings: Env; Variables: Variables }>();

const bodySchema = z.object({ episodeId: z.string().min(1).max(100), letterId: z.string().min(1).max(100), segmentIndex: z.number().int().min(0).max(10_000) });

/** The player calls this when a letter line starts. Only a letter the listener's own episode reads, in the segment it reads it, is recorded. */
listens.post("/listens", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "bad request" }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "bad request" }, 400);
  const { episodeId, letterId, segmentIndex } = parsed.data;

  const listener = c.get("listener");
  const episode = await getVerifiedEpisode(c.env.DB, episodeId);
  if (!episode || episode.listenerId !== listener.id) return c.notFound();
  // The index the player holds is the public view's, so the check reads the same view; a reply is not "heard".
  const { segments, letters } = await loadPublicEpisode(c.env.DB, episode);
  const read = segments[segmentIndex]?.lines.some((l) => l.type === "letter" && l.kind !== "reply" && l.letterId === letterId);
  if (!read || letters.get(letterId)?.status !== "public") return c.notFound();

  await recordListen(c.env.DB, { listenerId: listener.id, episodeId, letterId, segmentIndex });
  return c.body(null, 204);
});
