import { Hono } from "hono";
import type { Variables } from "../auth/session";
import { getVerifiedEpisode } from "../db/episodes";
import type { Env } from "../env";
import { loadPublicEpisode } from "../program/stored";
import { ttsIpRateLimit, ttsListenerRateLimit } from "../security/rate-limit";
import { ensureAudio, voiceOf } from "../tts/audio";

export const tts = new Hono<{ Bindings: Env; Variables: Variables }>();

const HEADERS = { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" };

tts.get("/tts", ttsIpRateLimit, ttsListenerRateLimit, async (c) => {
  const episodeId = c.req.query("episode");
  const rawLine = c.req.query("line");
  if (!episodeId || !rawLine || !/^\d+$/.test(rawLine)) return c.json({ error: "bad request" }, 400);
  const line = Number(rawLine);

  const episode = await getVerifiedEpisode(c.env.DB, episodeId);
  if (!episode || episode.listenerId !== c.get("listener").id) return c.notFound();

  const target = episode.segments.flatMap((s) => s.lines)[line];
  if (!target || (target.type !== "dj" && target.type !== "letter")) return c.json({ error: "bad request" }, 400);
  // A letter rejected since the episode was made, or the line that introduced it, is no longer voiced.
  if (!(await loadPublicEpisode(c.env.DB, episode)).storedIndex.includes(line)) return c.notFound();

  const ensured = await ensureAudio(c.env, c.env.DB, { text: target.text, lang: "ja", voice: voiceOf(c.env) });
  if (!ensured.ok) {
    if (ensured.reason === "limit") return c.json({ error: "tts limit" }, 503);
    if (ensured.reason === "busy") return c.json({ error: "tts busy" }, 503, { "retry-after": "2" });
    if (ensured.reason === "unavailable") return c.json({ error: "tts unavailable" }, 503);
    return c.json({ error: "tts failed" }, 502);
  }
  const clip = await c.env.BUCKET.get(ensured.key);
  if (!clip) return c.json({ error: "tts failed" }, 502);
  return new Response(clip.body, { headers: HEADERS });
});
