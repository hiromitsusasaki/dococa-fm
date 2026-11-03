import type { Listener } from "../types";

type Row = Record<string, unknown>;

function rowToListener(r: Row): Listener {
  return {
    id: r.id as string,
    radioName: r.radio_name as string,
    place: r.place as string,
    voice: r.voice as string,
    dial: r.dial as number,
    lang: r.lang as "ja",
    mcpToken: r.mcp_token as string,
    spotifyRefreshToken: (r.spotify_refresh_token as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export function newMcpToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createListener(db: D1Database): Promise<Listener> {
  const listener: Listener = {
    id: crypto.randomUUID(),
    radioName: "",
    place: "",
    voice: "",
    dial: 0.3,
    lang: "ja",
    mcpToken: newMcpToken(),
    spotifyRefreshToken: null,
    createdAt: new Date().toISOString(),
  };
  await db
    .prepare(
      `INSERT INTO listeners (id, radio_name, place, voice, dial, lang, mcp_token, spotify_refresh_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      listener.createdAt,
    )
    .run();
  return listener;
}

export async function getListener(db: D1Database, id: string): Promise<Listener | null> {
  const row = await db.prepare("SELECT * FROM listeners WHERE id = ?").bind(id).first<Row>();
  return row ? rowToListener(row) : null;
}

export async function getListenerByMcpToken(db: D1Database, token: string): Promise<Listener | null> {
  const row = await db.prepare("SELECT * FROM listeners WHERE mcp_token = ?").bind(token).first<Row>();
  return row ? rowToListener(row) : null;
}

const COLUMNS = {
  radioName: "radio_name",
  place: "place",
  voice: "voice",
  dial: "dial",
  lang: "lang",
  mcpToken: "mcp_token",
  spotifyRefreshToken: "spotify_refresh_token",
} as const;

export async function updateListener(db: D1Database, id: string, patch: Partial<Listener>): Promise<Listener | null> {
  const entries = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).filter((k) => patch[k] !== undefined);
  if (entries.length > 0) {
    const sets = entries.map((k) => `${COLUMNS[k]} = ?`).join(", ");
    await db
      .prepare(`UPDATE listeners SET ${sets} WHERE id = ?`)
      .bind(...entries.map((k) => patch[k] ?? null), id)
      .run();
  }
  return getListener(db, id);
}
