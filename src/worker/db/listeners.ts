import type { Listener } from "../types";

type Row = Record<string, unknown>;

function rowToListener(r: Row): Listener {
  return {
    id: r.id as string,
    radioName: r.radio_name as string,
    place: r.place as string,
    placeCountry: (r.place_country as string | null) ?? null,
    placeRegion: (r.place_region as string | null) ?? null,
    voice: r.voice as string,
    dial: r.dial as number,
    lang: r.lang as Listener["lang"],
    mcpToken: r.mcp_token as string,
    spotifyRefreshToken: (r.spotify_refresh_token as string | null) ?? null,
    cloudTtsUsed: r.cloud_tts_used === 1,
    demo: r.demo === 1,
    googleSub: (r.google_sub as string | null) ?? null,
    displayName: r.display_name as string,
    stationPublic: r.station_public === 1,
    stationSlug: (r.station_slug as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** What `newMcpToken` makes: 24 random bytes as 48 lower-case hex digits. */
export const isWellFormedMcpToken = (token: string): boolean => /^[0-9a-f]{48}$/.test(token);

export function newMcpToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createListener(db: D1Database, init: Partial<Pick<Listener, "radioName" | "place" | "demo" | "lang">> = {}): Promise<Listener> {
  const listener: Listener = {
    id: crypto.randomUUID(),
    radioName: init.radioName ?? "",
    place: init.place ?? "",
    placeCountry: null,
    placeRegion: null,
    voice: "",
    dial: 0.3,
    lang: init.lang ?? "ja",
    mcpToken: newMcpToken(),
    spotifyRefreshToken: null,
    cloudTtsUsed: false,
    demo: init.demo ?? false,
    googleSub: null,
    displayName: "",
    stationPublic: false,
    stationSlug: null,
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO listeners (id, radio_name, place, voice, dial, lang, mcp_token, spotify_refresh_token, demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      listener.id,
      listener.radioName,
      listener.place,
      listener.voice,
      listener.dial,
      listener.lang,
      listener.mcpToken,
      listener.spotifyRefreshToken,
      Number(listener.demo),
      listener.createdAt,
    )
    .run();
  return listener;
}

/** Atomically takes the listener's one cloud-voice episode: true for the single caller that flips the flag. */
export async function claimCloudTts(db: D1Database, id: string): Promise<boolean> {
  const res = await db.prepare("UPDATE listeners SET cloud_tts_used = 1 WHERE id = ? AND cloud_tts_used = 0").bind(id).run();
  return res.meta.changes > 0;
}

/** Gives the one cloud-voice episode back, after a failed insert. */
export async function releaseCloudTts(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE listeners SET cloud_tts_used = 0 WHERE id = ?").bind(id).run();
}

export async function getListener(db: D1Database, id: string): Promise<Listener | null> {
  const row = await db.prepare("SELECT * FROM listeners WHERE id = ?").bind(id).first<Row>();
  return row ? rowToListener(row) : null;
}

export async function getListenerByMcpToken(db: D1Database, token: string): Promise<Listener | null> {
  const row = await db.prepare("SELECT * FROM listeners WHERE mcp_token = ?").bind(token).first<Row>();
  return row ? rowToListener(row) : null;
}

export async function getListenerByGoogleSub(db: D1Database, sub: string): Promise<Listener | null> {
  const row = await db.prepare("SELECT * FROM listeners WHERE google_sub = ?").bind(sub).first<Row>();
  return row ? rowToListener(row) : null;
}

/** Only a public station is found by its slug. */
export async function getListenerBySlug(db: D1Database, slug: string): Promise<Listener | null> {
  const row = await db.prepare("SELECT * FROM listeners WHERE station_slug = ? AND station_public = 1").bind(slug).first<Row>();
  return row ? rowToListener(row) : null;
}

const COLUMNS = {
  radioName: "radio_name",
  place: "place",
  placeCountry: "place_country",
  placeRegion: "place_region",
  voice: "voice",
  dial: "dial",
  lang: "lang",
  mcpToken: "mcp_token",
  spotifyRefreshToken: "spotify_refresh_token",
  cloudTtsUsed: "cloud_tts_used",
  googleSub: "google_sub",
  displayName: "display_name",
  stationPublic: "station_public",
  stationSlug: "station_slug",
} as const;

export async function updateListener(db: D1Database, id: string, patch: Partial<Listener>): Promise<Listener | null> {
  const entries = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).filter((k) => patch[k] !== undefined);
  if (entries.length > 0) {
    const sets = entries.map((k) => `${COLUMNS[k]} = ?`).join(", ");
    await db
      .prepare(`UPDATE listeners SET ${sets} WHERE id = ?`)
      .bind(...entries.map((k) => (typeof patch[k] === "boolean" ? Number(patch[k]) : (patch[k] ?? null))), id)
      .run();
  }
  return getListener(db, id);
}

/**
 * Binds a Google account to a listener that has none yet. The write itself checks `google_sub IS NULL`, so two callbacks
 * racing on one listener cannot overwrite each other: the loser gets false. A sub already bound elsewhere throws (UNIQUE).
 */
export async function bindGoogleSub(db: D1Database, id: string, googleSub: string, displayName: string): Promise<boolean> {
  const res = await db.prepare("UPDATE listeners SET google_sub = ?, display_name = ? WHERE id = ? AND google_sub IS NULL").bind(googleSub, displayName, id).run();
  return (res.meta.changes ?? 0) > 0;
}

/** Whether the listener has played or written anything yet, without reading either list. */
export async function hasActivity(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT EXISTS (SELECT 1 FROM history WHERE listener_id = ?1) OR EXISTS (SELECT 1 FROM letters WHERE listener_id = ?1) AS any")
    .bind(id)
    .first<{ any: number }>();
  return row?.any === 1;
}
