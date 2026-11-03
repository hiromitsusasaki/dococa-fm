import { countEpisodesToday, insertEpisode } from "../db/episodes";
import { claimCloudTts } from "../db/listeners";
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
 * (the owner's demo), which does not use up the listener's first.
 */
export async function makeEpisode(env: Env, listener: Listener, opts: { cloudTts?: boolean } = {}): Promise<Made> {
  if ((await countEpisodesToday(env.DB, listener.id)) >= dailyLimit(env)) return { ok: false, reason: "limit" };
  try {
    const built = await buildEpisode(env, env.DB, listener);
    const cloudTts = opts.cloudTts === true || (await claimCloudTts(env.DB, listener.id));
    const episode = await insertEpisode(env.DB, { ...built, cloudTts });
    return { ok: true, id: episode.id };
  } catch (e) {
    console.error(`[dococa] episode build failed: ${e instanceof Error ? e.name : "unknown"}`);
    return { ok: false, reason: "unavailable" };
  }
}
