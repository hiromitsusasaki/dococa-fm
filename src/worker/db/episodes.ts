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
    lang: r.lang === "en" ? "en" : "ja",
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
  e: Omit<Episode, "id" | "createdAt" | "cloudTts" | "station" | "lang"> & { id?: string; createdAt?: string; cloudTts?: boolean; station?: string; lang?: Episode["lang"] },
): Promise<Episode> {
  const episode: Episode = {
    ...e,
    cloudTts: e.cloudTts ?? false,
    station: e.station ?? "mine",
    lang: e.lang ?? "ja",
    id: e.id ?? crypto.randomUUID(),
    createdAt: e.createdAt ?? new Date().toISOString(),
  };
  await db
    .prepare("INSERT INTO episodes (id, listener_id, segments, verified, report, cloud_tts, station, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(
      episode.id,
      episode.listenerId,
      JSON.stringify(episode.segments),
      episode.verified ? 1 : 0,
      JSON.stringify(episode.report),
      episode.cloudTts ? 1 : 0,
      episode.station,
      episode.lang,
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

/** The only reads that leave the worker: an unverified row is never shown, served or voiced. */
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

/** The listener's latest verified episode made on one station (see `stationColumn`) in one language. */
export async function latestVerifiedEpisodeOn(db: D1Database, listenerId: string, station: string, lang: Episode["lang"]): Promise<Episode | null> {
  const row = await db
    .prepare("SELECT * FROM episodes WHERE listener_id = ? AND station = ? AND lang = ? AND verified = 1 ORDER BY created_at DESC, id DESC LIMIT 1")
    .bind(listenerId, station, lang)
    .first<Row>();
  return row ? rowToEpisode(row) : null;
}

/** Who sent the first letter of an archived episode, as the episode stored it (the name line is made by the caller). */
export type ArchiveSender = { radioName: string; place: string; placeCountry?: string; placeRegion?: string; kind: string; sourceAuthor: string | null; demo?: true };

/**
 * The archive rows in one query: each verified episode the listener heard something in (a `listens` row; an episode
 * fetched ahead and never played is left out), newest first, with the title of its first work and the sender of its
 * first letter (taken from the stored lines; null when the first segment reads none). Only a letter or a found voice
 * names the sender: a reply or 私も read in that segment is someone reacting, not the sender. The letters' current
 * status decides what shows: a first letter no longer public (rejected, withdrawn) names no sender, and a row whose
 * first segment read letters none of which is still public is left out.
 */
export async function listArchive(db: D1Database, listenerId: string, limit: number): Promise<Array<{ id: string; createdAt: string; title: string | null; kind: string | null; creator: string | null; imageUrl: string | null; sender: ArchiveSender | null }>> {
  const read = `FROM json_each(x.segments, '$[0].lines') AS l WHERE json_extract(l.value, '$.type') = 'letter' AND json_extract(l.value, '$.kind') IN ('letter', 'found')`;
  const { results } = await db
    .prepare(
      `SELECT x.id, x.created_at, i.title, i.kind, i.creator, i.image_url,
         CASE WHEN (SELECT status FROM letters WHERE id = json_extract(x.first_letter, '$.letterId')) = 'public' THEN x.first_letter END AS first_letter
       FROM (
         SELECT e.id, e.created_at, e.segments,
           (SELECT l.value FROM json_each(e.segments, '$[0].lines') AS l WHERE json_extract(l.value, '$.type') = 'letter' AND json_extract(l.value, '$.kind') IN ('letter', 'found') LIMIT 1) AS first_letter
         FROM episodes e
         WHERE e.listener_id = ? AND e.verified = 1 AND EXISTS (SELECT 1 FROM listens WHERE listener_id = e.listener_id AND episode_id = e.id)
       ) AS x
       LEFT JOIN items i ON i.id = json_extract(x.segments, '$[0].itemId')
       WHERE x.first_letter IS NULL
         OR EXISTS (SELECT 1 ${read} AND EXISTS (SELECT 1 FROM letters WHERE id = json_extract(l.value, '$.letterId') AND status = 'public'))
       ORDER BY x.created_at DESC, x.id DESC LIMIT ?`,
    )
    .bind(listenerId, limit)
    .all<{ id: string; created_at: string; title: string | null; kind: string | null; creator: string | null; image_url: string | null; first_letter: string | null }>();
  return results.map((r) => ({ id: r.id, createdAt: r.created_at, title: r.title ?? null, kind: r.kind ?? null, creator: r.creator ?? null, imageUrl: r.image_url ?? null, sender: senderOf(r.first_letter) }));
}

function senderOf(json: string | null): ArchiveSender | null {
  if (!json) return null;
  try {
    const l = JSON.parse(json) as Partial<ArchiveSender>;
    if (typeof l.radioName !== "string" || typeof l.place !== "string" || typeof l.kind !== "string") return null;
    return {
      radioName: l.radioName,
      place: l.place,
      ...(typeof l.placeCountry === "string" ? { placeCountry: l.placeCountry } : {}),
      ...(typeof l.placeRegion === "string" ? { placeRegion: l.placeRegion } : {}),
      kind: l.kind,
      sourceAuthor: typeof l.sourceAuthor === "string" ? l.sourceAuthor : null,
      ...(l.demo === true ? { demo: true as const } : {}),
    };
  } catch {
    return null;
  }
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
