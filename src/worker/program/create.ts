import { countAllEpisodesToday, countCloudTtsToday, countEpisodesToday, insertEpisode } from "../db/episodes";
import { claimCloudTts, releaseCloudTts } from "../db/listeners";
import type { Env } from "../env";
import type { Listener } from "../types";
import { buildEpisode } from "./build";

const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_GLOBAL_DAILY_LIMIT = 300;
const DEFAULT_CLOUD_TTS_GLOBAL_DAILY_LIMIT = 50;

/** A whole number from an env value; `0` means paused, and a missing or invalid value falls back to the default. */
export function limitFrom(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type Made = { ok: true; id: string } | { ok: false; reason: "limit" | "unavailable" | "empty" };

/**
 * Limit check, build, store. Failures are logged by error name only: report details can quote lines.
 * An episode with no segment (nothing written anywhere yet) is not stored and answers `empty`.
 * The cloud voice goes to the listener's first episode, or to any episode made with `cloudTts: true`
 * (the owner's demo), which does not use up the listener's first. Without a TTS key nothing is
 * claimed and no episode gets the voice: the player would have nothing to play.
 */
export async function makeEpisode(env: Env, listener: Listener, opts: { cloudTts?: boolean } = {}): Promise<Made> {
  // The per-listener cap resets with a new cookie, so a global cap bounds what a cookie-reset loop can spend.
  if ((await countEpisodesToday(env.DB, listener.id)) >= limitFrom(env.EPISODE_DAILY_LIMIT, DEFAULT_DAILY_LIMIT)) return { ok: false, reason: "limit" };
  if ((await countAllEpisodesToday(env.DB)) >= limitFrom(env.EPISODE_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT)) return { ok: false, reason: "limit" };
  try {
    const built = await buildEpisode(env, env.DB, listener);
    // Nothing to play yet: no row, so the daily limits are not used up.
    if (built.segments.length === 0) return { ok: false, reason: "empty" };
    const hasKey = Boolean(env.GOOGLE_TTS_SA_JSON);
    if (!hasKey && opts.cloudTts === true) console.warn("[dococa] cloud tts requested but GOOGLE_TTS_SA_JSON is empty; using the browser voice");
    const demo = hasKey && opts.cloudTts === true;
    // Past the global cloud-voice cap the episode is still made, with the browser voice. The owner's demo episodes are not counted against it.
    const cloudAllowed = hasKey && !demo && (await countCloudTtsToday(env.DB)) < limitFrom(env.CLOUD_TTS_GLOBAL_DAILY_LIMIT, DEFAULT_CLOUD_TTS_GLOBAL_DAILY_LIMIT);
    const claimed = cloudAllowed && (await claimCloudTts(env.DB, listener.id));
    try {
      const episode = await insertEpisode(env.DB, { ...built, cloudTts: demo || claimed });
      return { ok: true, id: episode.id };
    } catch (e) {
      if (claimed) await releaseCloudTts(env.DB, listener.id);
      throw e;
    }
  } catch (e) {
    console.error(`[dococa] episode build failed: ${e instanceof Error ? e.name : "unknown"}`);
    return { ok: false, reason: "unavailable" };
  }
}
