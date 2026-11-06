import { z } from "zod";
import { countAllEpisodesToday, countEpisodesToday, insertEpisode } from "../db/episodes";
import { setListenerDial } from "../db/listeners";
import type { Env } from "../env";
import { limitFrom } from "../limits";
import type { Listener } from "../types";
import { buildEpisode } from "./build";
import { type StationKey, stationColumn } from "./station";

/** Episodes are one segment each, so the limits count segments (枠): 60 a listener, 1800 overall, per JST day. */
const DEFAULT_DAILY_LIMIT = 60;
const DEFAULT_GLOBAL_DAILY_LIMIT = 1800;

export type MakeOptions = {
  station?: StationKey;
  /** The player's dial for this request (0..1); a signed-in listener's stored dial follows it. */
  dial?: number;
  /** The first programme of a visit: the DJ opens it. */
  first?: boolean;
  /** A letter the listener came to hear: it takes the seat when it may be read. */
  letterId?: string;
  /** Segments in the episode; 1 for every listener. Only the operator's eval asks for more, to measure a whole programme. */
  size?: number;
};

const nextBody = z.object({
  dial: z.number().min(0).max(1).optional(),
  first: z.boolean().optional(),
  letterId: z.string().min(1).max(100).optional(),
});
export type NextBody = z.infer<typeof nextBody>;

/**
 * The body of a "next" request (`{ dial?, first?, letterId? }`, JSON). No body, or one that is not JSON (a form post),
 * is `{}`; JSON of the wrong shape is null, which the route answers with 400.
 */
export async function readNextBody(req: Request): Promise<NextBody | null> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() === "" ? null : JSON.parse(text);
  } catch {
    return {};
  }
  if (raw === null) return {};
  const parsed = nextBody.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type Made = { ok: true; id: string } | { ok: false; reason: "limit" | "unavailable" | "empty" };

/**
 * Limit check, build, store. Failures are logged by error name only: report details can quote lines.
 * An episode with no segment (nothing written anywhere yet) is not stored and answers `empty`.
 * Every episode gets the cloud voice when a TTS key exists; the synth cap is applied per line by `ensureAudio`.
 * Every episode is one segment: the player asks again for each, with the dial as it is then.
 */
export async function makeEpisode(env: Env, listener: Listener, opts: MakeOptions = {}): Promise<Made> {
  // Only a signed-in listener's dial is kept: an anonymous one lives in the browser alone.
  if (opts.dial !== undefined && listener.googleSub !== null && opts.dial !== listener.dial) await setListenerDial(env.DB, listener.id, opts.dial);
  // The per-listener cap resets with a new cookie, so a global cap bounds what a cookie-reset loop can spend.
  if ((await countEpisodesToday(env.DB, listener.id)) >= limitFrom(env.EPISODE_DAILY_LIMIT, DEFAULT_DAILY_LIMIT)) return { ok: false, reason: "limit" };
  if ((await countAllEpisodesToday(env.DB)) >= limitFrom(env.EPISODE_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT)) return { ok: false, reason: "limit" };
  try {
    const built = await buildEpisode(env, env.DB, listener, {
      size: opts.size ?? 1,
      first: opts.first === true,
      ...(opts.station ? { station: opts.station } : {}),
      ...(opts.dial !== undefined ? { dial: opts.dial } : {}),
      ...(opts.letterId ? { letterId: opts.letterId } : {}),
    });
    // Nothing to play yet: no row, so the daily limits are not used up.
    if (built.segments.length === 0) return { ok: false, reason: "empty" };
    const episode = await insertEpisode(env.DB, { ...built, cloudTts: Boolean(env.GOOGLE_TTS_SA_JSON), station: stationColumn(opts.station) });
    return { ok: true, id: episode.id };
  } catch (e) {
    console.error(`[dococa] episode build failed: ${e instanceof Error ? e.name : "unknown"}`);
    return { ok: false, reason: "unavailable" };
  }
}
