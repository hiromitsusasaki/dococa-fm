import { Hono } from "hono";
import { z } from "zod";
import type { Variables } from "../auth/session";
import { getVerifiedEpisode } from "../db/episodes";
import { recordListen } from "../db/listens";
import type { Env } from "../env";
import { loadPublicEpisode, segmentReading } from "../program/stored";
import { listensListenerRateLimit } from "../security/rate-limit";

export const listens = new Hono<{ Bindings: Env; Variables: Variables }>();

/** `segmentIndex` is advisory and ignored: the public view's indices shift when an earlier letter is taken down. */
const bodySchema = z.object({ episodeId: z.string().min(1).max(100), letterId: z.string().min(1).max(100), segmentIndex: z.number().int().min(0).max(10_000).optional() });

/**
 * The player calls this when a letter line starts. Only a public letter the listener's own episode reads is
 * recorded, with the public-view segment that reads it now.
 */
// The IP bucket (`listensIpRateLimit`) is mounted in index.ts before the session middleware.
listens.post("/listens", listensListenerRateLimit, async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "bad request" }, 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "bad request" }, 400);
  const { episodeId, letterId } = parsed.data;

  const listener = c.get("listener");
  const episode = await getVerifiedEpisode(c.env.DB, episodeId);
  if (!episode || episode.listenerId !== listener.id) return c.notFound();
  // The segment is found in the public view, as `/episodes/:id?letter=` finds it; a reply is not "heard".
  const { segments, letters } = await loadPublicEpisode(c.env.DB, episode);
  const segmentIndex = segmentReading(segments, letterId);
  if (segmentIndex < 0 || letters.get(letterId)?.status !== "public") return c.notFound();

  await recordListen(c.env.DB, { listenerId: listener.id, episodeId, letterId, segmentIndex });
  return c.body(null, 204);
});
