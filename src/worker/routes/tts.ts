import { Hono } from "hono";
import type { Variables } from "../auth/session";
import { getEpisode } from "../db/episodes";
import type { Env } from "../env";
import { synthesize } from "../tts/google";

export const tts = new Hono<{ Bindings: Env; Variables: Variables }>();

const HEADERS = { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" };

tts.get("/tts", async (c) => {
  const episodeId = c.req.query("episode");
  const rawLine = c.req.query("line");
  if (!episodeId || !rawLine || !/^\d+$/.test(rawLine)) return c.json({ error: "bad request" }, 400);
  const line = Number(rawLine);

  const episode = await getEpisode(c.env.DB, episodeId);
  if (!episode || episode.listenerId !== c.get("listener").id || !episode.cloudTts) return c.notFound();

  const target = episode.segments.flatMap((s) => s.lines)[line];
  if (!target || (target.type !== "dj" && target.type !== "letter")) return c.json({ error: "bad request" }, 400);

  const key = `tts/${episode.id}/${line}.mp3`;
  const cached = await c.env.BUCKET.get(key);
  if (cached) return new Response(cached.body, { headers: HEADERS });

  if (!c.env.GOOGLE_TTS_API_KEY) return c.json({ error: "tts unavailable" }, 503);
  try {
    const audio = await synthesize(c.env, target.text, c.env.GEMINI_TTS_VOICE === "female" ? "female" : "male");
    await c.env.BUCKET.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" } });
    return new Response(audio, { headers: HEADERS });
  } catch (e) {
    console.error(`[dococa] tts failed: ${e instanceof Error ? e.message : "unknown"}`);
    return c.json({ error: "tts failed" }, 502);
  }
});
