import type { Episode } from "../types";

type Row = Record<string, unknown>;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function rowToEpisode(r: Row): Episode {
  return {
    id: r.id as string,
    listenerId: r.listener_id as string,
    segments: JSON.parse(r.segments as string),
    verified: r.verified === 1,
    report: JSON.parse(r.report as string),
    cloudTts: r.cloud_tts === 1,
    station: r.station as string,
    createdAt: r.created_at as string,
  };
}

/** The UTC instant (ISO) at which the Asia/Tokyo calendar day containing `now` began. */
export function jstDayStartIso(now: Date): string {
  const jstMs = now.getTime() + JST_OFFSET_MS;
  return new Date(jstMs - (jstMs % DAY_MS) - JST_OFFSET_MS).toISOString();
}

export async function insertEpisode(
  db: D1Database,
  e: Omit<Episode, "id" | "createdAt" | "cloudTts" | "station"> & { id?: string; createdAt?: string; cloudTts?: boolean; station?: string },
): Promise<Episode> {
  const episode: Episode = { ...e, cloudTts: e.cloudTts ?? false, station: e.station ?? "mine", id: e.id ?? crypto.randomUUID(), createdAt: e.createdAt ?? new Date().toISOString() };
  await db
    .prepare("INSERT INTO episodes (id, listener_id, segments, verified, report, cloud_tts, station, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      episode.id,
      episode.listenerId,
      JSON.stringify(episode.segments),
      episode.verified ? 1 : 0,
      JSON.stringify(episode.report),
      episode.cloudTts ? 1 : 0,
      episode.station,
      episode.createdAt,
    )
    .run();
  return episode;
}

export async function getEpisode(db: D1Database, id: string): Promise<Episode | null> {
  const row = await db.prepare("SELECT * FROM episodes WHERE id = ?").bind(id).first<Row>();
  return row ? rowToEpisode(row) : null;
}

export async function listEpisodes(db: D1Database, listenerId: string, limit: number): Promise<Episode[]> {
  const { results } = await db
    .prepare("SELECT * FROM episodes WHERE listener_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(listenerId, limit)
    .all<Row>();
  return results.map(rowToEpisode);
}

/** The only reads that leave the worker: an unverified row is never shown, served, voiced or handed to MCP. */
export async function getVerifiedEpisode(db: D1Database, id: string): Promise<Episode | null> {
  const row = await db.prepare("SELECT * FROM episodes WHERE id = ? AND verified = 1").bind(id).first<Row>();
  return row ? rowToEpisode(row) : null;
}

export async function listVerifiedEpisodes(db: D1Database, listenerId: string, limit: number): Promise<Episode[]> {
  const { results } = await db
    .prepare("SELECT * FROM episodes WHERE listener_id = ? AND verified = 1 ORDER BY created_at DESC, id DESC LIMIT ?")
    .bind(listenerId, limit)
    .all<Row>();
  return results.map(rowToEpisode);
}

/** The listener's latest verified episode made on one station (see `stationColumn`). */
export async function latestVerifiedEpisodeOn(db: D1Database, listenerId: string, station: string): Promise<Episode | null> {
  const row = await db
    .prepare("SELECT * FROM episodes WHERE listener_id = ? AND station = ? AND verified = 1 ORDER BY created_at DESC, id DESC LIMIT 1")
    .bind(listenerId, station)
    .first<Row>();
  return row ? rowToEpisode(row) : null;
}

/** The archive rows in one query: each verified episode with the title of its first work. */
export async function listArchive(db: D1Database, listenerId: string, limit: number): Promise<Array<{ id: string; createdAt: string; title: string | null }>> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.created_at, i.title FROM episodes e
       LEFT JOIN items i ON i.id = json_extract(e.segments, '$[0].itemId')
       WHERE e.listener_id = ? AND e.verified = 1
       ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    )
    .bind(listenerId, limit)
    .all<{ id: string; created_at: string; title: string | null }>();
  return results.map((r) => ({ id: r.id, createdAt: r.created_at, title: r.title ?? null }));
}

export async function countEpisodesToday(db: D1Database, listenerId: string, now: Date = new Date()): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM episodes WHERE listener_id = ? AND created_at >= ?")
    .bind(listenerId, jstDayStartIso(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Episodes made by anyone since the JST day began. */
export async function countAllEpisodesToday(db: D1Database, now: Date = new Date()): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE created_at >= ?").bind(jstDayStartIso(now)).first<{ n: number }>();
  return row?.n ?? 0;
}
