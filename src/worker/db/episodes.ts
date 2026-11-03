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
  e: Omit<Episode, "id" | "createdAt"> & { id?: string; createdAt?: string },
): Promise<Episode> {
  const episode: Episode = { ...e, id: e.id ?? crypto.randomUUID(), createdAt: e.createdAt ?? new Date().toISOString() };
  await db
    .prepare("INSERT INTO episodes (id, listener_id, segments, verified, report, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(
      episode.id,
      episode.listenerId,
      JSON.stringify(episode.segments),
      episode.verified ? 1 : 0,
      JSON.stringify(episode.report),
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

export async function countEpisodesToday(db: D1Database, listenerId: string, now: Date = new Date()): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM episodes WHERE listener_id = ? AND created_at >= ?")
    .bind(listenerId, jstDayStartIso(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}
