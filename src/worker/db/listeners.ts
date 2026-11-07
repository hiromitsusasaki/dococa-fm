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

export function newMcpToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createListener(db: D1Database, init: Partial<Pick<Listener, "radioName" | "place" | "placeCountry" | "placeRegion" | "demo" | "lang">> = {}): Promise<Listener> {
  const listener: Listener = {
    id: crypto.randomUUID(),
    radioName: init.radioName ?? "",
    place: init.place ?? "",
    placeCountry: init.placeCountry ?? null,
    placeRegion: init.placeRegion ?? null,
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
      `INSERT INTO listeners (id, radio_name, place, place_country, place_region, voice, dial, lang, mcp_token, spotify_refresh_token, demo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      listener.id,
      listener.radioName,
      listener.place,
      listener.placeCountry,
      listener.placeRegion,
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

export async function getListener(db: D1Database, id: string): Promise<Listener | null> {
  const row = await db.prepare("SELECT * FROM listeners WHERE id = ?").bind(id).first<Row>();
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
  // Column kept, unused since Phase 4 (NOT NULL UNIQUE; written on insert only).
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

/** Writes the slug only while the listener has none, so two requests racing to assign one cannot replace each other. A slug held by another listener throws (UNIQUE). */
export async function setStationSlugIfNone(db: D1Database, id: string, slug: string): Promise<void> {
  await db.prepare("UPDATE listeners SET station_slug = ? WHERE id = ? AND station_slug IS NULL").bind(slug, id).run();
}

/** The dial alone, in one write: the player sends it with every request. */
export async function setListenerDial(db: D1Database, id: string, dial: number): Promise<void> {
  await db.prepare("UPDATE listeners SET dial = ? WHERE id = ?").bind(dial, id).run();
}

/**
 * Binds a Google account to a listener that has none yet. The write itself checks `google_sub IS NULL`, so two callbacks
 * racing on one listener cannot overwrite each other: the loser gets false. A sub already bound elsewhere throws (UNIQUE).
 */
export async function bindGoogleSub(db: D1Database, id: string, googleSub: string, displayName: string): Promise<boolean> {
  const res = await db.prepare("UPDATE listeners SET google_sub = ?, display_name = ? WHERE id = ? AND google_sub IS NULL").bind(googleSub, displayName, id).run();
  return (res.meta.changes ?? 0) > 0;
}

