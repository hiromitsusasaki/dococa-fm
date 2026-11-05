import { Hono } from "hono";
import type { Variables } from "../auth/session";
import { getVerifiedEpisode, listVerifiedEpisodes } from "../db/episodes";
import { getListenerBySlug } from "../db/listeners";
import type { Env } from "../env";
import { makeEpisode } from "../program/create";
import { playerView } from "../program/player-view";
import { type StationKey, parseStationKey, stationLabel } from "../program/station";

export const stations = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The route's key as a station, with the owner's name for the label. Null when it is not a station a listener can tune to. */
async function resolve(db: D1Database, raw: string): Promise<{ key: StationKey; ownerName: string } | null> {
  const parsed = parseStationKey(raw);
  if (!parsed) return null;
  if (parsed.kind !== "public") return { key: parsed, ownerName: "" };
  const owner = await getListenerBySlug(db, parsed.slug);
  return owner ? { key: { kind: "public", ownerId: owner.id }, ownerName: owner.radioName } : null;
}

stations.post("/stations/:key/next", async (c) => {
  const raw = c.req.param("key");
  const listener = c.get("listener");
  const station = await resolve(c.env.DB, raw);
  if (!station) return c.json({ error: "station" }, 404);
  const made = await makeEpisode(c.env, listener, { station: station.key });
  if (!made.ok) return c.json({ error: made.reason }, made.reason === "limit" ? 429 : made.reason === "empty" ? 409 : 503);
  const stored = await getVerifiedEpisode(c.env.DB, made.id);
  if (!stored) return c.json({ error: "unavailable" }, 503);
  return c.json({
    episode: await playerView(c.env.DB, stored, listener.lang),
    station: { key: raw, label: stationLabel(station.key, station.ownerName, listener.lang) },
  });
});

/**
 * Resume after a reload: the listener's latest verified episode. Episodes carry no station column, so this is
 * the latest one whatever station it was made on; the station named in the url only supplies the label.
 */
stations.get("/stations/:key", async (c) => {
  const param = c.req.param("key");
  if (!param.endsWith(".json")) return c.notFound();
  const raw = param.slice(0, -".json".length);
  const listener = c.get("listener");
  const station = await resolve(c.env.DB, raw);
  if (!station) return c.json({ error: "station" }, 404);
  const [latest] = await listVerifiedEpisodes(c.env.DB, listener.id, 1);
  if (!latest) return c.body(null, 204);
  return c.json({
    episode: await playerView(c.env.DB, latest, listener.lang),
    station: { key: raw, label: stationLabel(station.key, station.ownerName, listener.lang) },
  });
});
