import { countAllEpisodesToday, countEpisodesToday, insertEpisode } from "../db/episodes";
import type { Env } from "../env";
import { limitFrom } from "../limits";
import type { Listener } from "../types";
import { buildEpisode } from "./build";
import { type StationKey, stationColumn } from "./station";

const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_GLOBAL_DAILY_LIMIT = 300;

export type Made = { ok: true; id: string } | { ok: false; reason: "limit" | "unavailable" | "empty" };

/**
 * Limit check, build, store. Failures are logged by error name only: report details can quote lines.
 * An episode with no segment (nothing written anywhere yet) is not stored and answers `empty`.
 * Every episode gets the cloud voice when a TTS key exists; the synth cap is applied per line by `ensureAudio`.
 */
export async function makeEpisode(env: Env, listener: Listener, opts: { station?: StationKey } = {}): Promise<Made> {
  // The per-listener cap resets with a new cookie, so a global cap bounds what a cookie-reset loop can spend.
  if ((await countEpisodesToday(env.DB, listener.id)) >= limitFrom(env.EPISODE_DAILY_LIMIT, DEFAULT_DAILY_LIMIT)) return { ok: false, reason: "limit" };
  if ((await countAllEpisodesToday(env.DB)) >= limitFrom(env.EPISODE_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT)) return { ok: false, reason: "limit" };
  try {
    const built = await buildEpisode(env, env.DB, listener, opts.station ? { station: opts.station } : {});
    // Nothing to play yet: no row, so the daily limits are not used up.
    if (built.segments.length === 0) return { ok: false, reason: "empty" };
    const episode = await insertEpisode(env.DB, { ...built, cloudTts: Boolean(env.GOOGLE_TTS_SA_JSON), station: stationColumn(opts.station) });
    return { ok: true, id: episode.id };
  } catch (e) {
    console.error(`[dococa] episode build failed: ${e instanceof Error ? e.name : "unknown"}`);
    return { ok: false, reason: "unavailable" };
  }
}
