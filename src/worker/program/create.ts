import { countEpisodesToday, insertEpisode } from "../db/episodes";
import { claimCloudTts, releaseCloudTts } from "../db/listeners";
import type { Env } from "../env";
import type { Listener } from "../types";
import { buildEpisode } from "./build";

const DEFAULT_DAILY_LIMIT = 10;

function dailyLimit(env: Env): number {
  const n = Number.parseInt(env.EPISODE_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

export type Made = { ok: true; id: string } | { ok: false; reason: "limit" | "unavailable" };

/**
 * Limit check, build, store. Failures are logged by error name only: report details can quote lines.
 * The cloud voice goes to the listener's first episode, or to any episode made with `cloudTts: true`
 * (the owner's demo), which does not use up the listener's first. Without a TTS key nothing is
 * claimed and no episode gets the voice: the player would have nothing to play.
 */
export async function makeEpisode(env: Env, listener: Listener, opts: { cloudTts?: boolean } = {}): Promise<Made> {
  if ((await countEpisodesToday(env.DB, listener.id)) >= dailyLimit(env)) return { ok: false, reason: "limit" };
  try {
    const built = await buildEpisode(env, env.DB, listener);
    const hasKey = Boolean(env.GOOGLE_TTS_API_KEY);
    if (!hasKey && opts.cloudTts === true) console.warn("[dococa] cloud tts requested but GOOGLE_TTS_API_KEY is empty; using the browser voice");
    const demo = hasKey && opts.cloudTts === true;
    const claimed = hasKey && !demo && (await claimCloudTts(env.DB, listener.id));
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
