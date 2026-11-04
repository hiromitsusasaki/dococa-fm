import { Hono } from "hono";
import type { Variables } from "../auth/session";
import { getVerifiedEpisode } from "../db/episodes";
import type { Env } from "../env";
import { loadPublicEpisode } from "../program/stored";
import { ttsIpRateLimit, ttsListenerRateLimit } from "../security/rate-limit";
import { claimTts, releaseTts } from "../tts/claim";
import { synthesize } from "../tts/google";

export const tts = new Hono<{ Bindings: Env; Variables: Variables }>();

const HEADERS = { "content-type": "audio/mpeg", "cache-control": "private, max-age=86400" };
/** How long a request that lost the claim waits for the winner's clip to appear in R2. */
const WAIT_MS = 5_000;
const POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

tts.get("/tts", ttsIpRateLimit, ttsListenerRateLimit, async (c) => {
  const episodeId = c.req.query("episode");
  const rawLine = c.req.query("line");
  if (!episodeId || !rawLine || !/^\d+$/.test(rawLine)) return c.json({ error: "bad request" }, 400);
  const line = Number(rawLine);

  const episode = await getVerifiedEpisode(c.env.DB, episodeId);
  if (!episode || episode.listenerId !== c.get("listener").id || !episode.cloudTts) return c.notFound();

  const target = episode.segments.flatMap((s) => s.lines)[line];
  if (!target || (target.type !== "dj" && target.type !== "letter")) return c.json({ error: "bad request" }, 400);
  // A letter rejected since the episode was made, or the line that introduced it, is no longer voiced.
  if (!(await loadPublicEpisode(c.env.DB, episode)).storedIndex.includes(line)) return c.notFound();

  const key = `tts/${episode.id}/${line}.mp3`;
  const cached = await c.env.BUCKET.get(key);
  if (cached) return new Response(cached.body, { headers: HEADERS });

  if (!c.env.GOOGLE_TTS_API_KEY) return c.json({ error: "tts unavailable" }, 503);

  // Single flight: only the claim holder calls Google; the others wait for its clip.
  if (!(await claimTts(c.env.DB, key))) {
    for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
      await sleep(POLL_MS);
      const ready = await c.env.BUCKET.get(key);
      if (ready) return new Response(ready.body, { headers: HEADERS });
    }
    return c.json({ error: "tts busy" }, 503, { "retry-after": "2" });
  }
  try {
    const audio = await synthesize(c.env, target.text, c.env.GEMINI_TTS_VOICE === "female" ? "female" : "male");
    await c.env.BUCKET.put(key, audio, { httpMetadata: { contentType: "audio/mpeg" } });
    return new Response(audio, { headers: HEADERS });
  } catch (e) {
    // Name and status only: a fetch TypeError can quote the request URL, which carries the key.
    const status = e instanceof Error && /^tts \d+$/.test(e.message) ? ` ${e.message}` : "";
    console.error(`[dococa] tts failed: ${e instanceof Error ? e.name : "unknown"}${status}`);
    return c.json({ error: "tts failed" }, 502);
  } finally {
    await releaseTts(c.env.DB, key);
  }
});
