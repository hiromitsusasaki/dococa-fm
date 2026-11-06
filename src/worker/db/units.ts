import type { Unit } from "../types";
import { jstDayStartIso } from "./episodes";

type Row = Record<string, unknown>;

const rowToUnit = (r: Row): Unit => ({
  letterId: r.letter_id as string,
  lang: r.lang as Unit["lang"],
  intro: r.intro as string,
  after: r.after as string,
  verified: r.verified === 1,
  audioReady: r.audio_ready === 1,
  createdAt: r.created_at as string,
});

/** D1 binds at most 100 parameters per statement; one is the language. */
const IN_CHUNK = 90;

/** The stored units of the letters in `lang`, keyed by letter id; letters without one are absent. */
export async function getUnits(db: D1Database, letterIds: Iterable<string>, lang: Unit["lang"]): Promise<Map<string, Unit>> {
  const unique = [...new Set(letterIds)];
  const out = new Map<string, Unit>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT * FROM units WHERE lang = ? AND letter_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(lang, ...chunk)
      .all<Row>();
    for (const r of results) out.set(r.letter_id as string, rowToUnit(r));
  }
  return out;
}

/**
 * Stores the unit, replacing an earlier unverified one for the same letter and language. A verified unit is
 * final: a later write for its key is dropped, so its clips are never re-made. Returns the unit as written;
 * read the row back to learn what is stored. One statement.
 */
export async function upsertUnit(db: D1Database, u: Omit<Unit, "createdAt"> & { createdAt?: string }): Promise<Unit> {
  const unit: Unit = { ...u, createdAt: u.createdAt ?? new Date().toISOString() };
  await db
    .prepare(
      `INSERT INTO units (letter_id, lang, intro, after, verified, audio_ready, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(letter_id, lang) DO UPDATE SET intro = excluded.intro, after = excluded.after, verified = excluded.verified,
         audio_ready = excluded.audio_ready, created_at = excluded.created_at
       WHERE units.verified = 0`,
    )
    .bind(unit.letterId, unit.lang, unit.intro, unit.after, unit.verified ? 1 : 0, unit.audioReady ? 1 : 0, unit.createdAt)
    .run();
  return unit;
}

/**
 * Flags the unit only while it still has the texts whose clips the caller made: a unit replaced meanwhile
 * (two runs made one for the same letter) is left alone, and the next run voices the new text.
 */
export async function setUnitAudioReady(db: D1Database, letterId: string, lang: Unit["lang"], ready: boolean, voiced: Pick<Unit, "intro" | "after">): Promise<void> {
  await db
    .prepare("UPDATE units SET audio_ready = ? WHERE letter_id = ? AND lang = ? AND intro = ? AND after = ?")
    .bind(ready ? 1 : 0, letterId, lang, voiced.intro, voiced.after)
    .run();
}

/** A found voice without a source can never be verified, so it never gets a unit (it would be re-made on every run). */
const READABLE = `l.status = 'public' AND l.kind IN ('letter', 'found')
         AND (l.kind <> 'found' OR (TRIM(COALESCE(l.source_url, '')) <> '' AND TRIM(COALESCE(l.source_author, '')) <> ''))`;

/** Public, sourced letters of kind letter/found with no unit in `lang`, oldest first. Reactions are fixed lines and have no unit. */
export async function listLettersWithoutUnit(db: D1Database, lang: Unit["lang"], limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id FROM letters l
       WHERE ${READABLE}
         AND NOT EXISTS (SELECT 1 FROM units u WHERE u.letter_id = l.id AND u.lang = ?)
       ORDER BY l.created_at ASC, l.id ASC
       LIMIT ?`,
    )
    .bind(lang, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Verified units whose audio is not ready yet, oldest first. Only units of letters still public: a letter
 * rejected or taken down after its unit was made is never voiced.
 */
export async function listUnitsWithoutAudio(db: D1Database, lang: Unit["lang"], limit: number): Promise<Unit[]> {
  const { results } = await db
    .prepare(
      `SELECT u.* FROM units u JOIN letters l ON l.id = u.letter_id
       WHERE u.lang = ? AND u.verified = 1 AND u.audio_ready = 0 AND l.status = 'public'
       ORDER BY u.created_at ASC, u.letter_id ASC
       LIMIT ?`,
    )
    .bind(lang, limit)
    .all<Row>();
  return results.map(rowToUnit);
}

/** Letters `listLettersWithoutUnit` would list, counted. */
export async function countLettersWithoutUnit(db: D1Database, lang: Unit["lang"]): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM letters l
       WHERE ${READABLE}
         AND NOT EXISTS (SELECT 1 FROM units u WHERE u.letter_id = l.id AND u.lang = ?)`,
    )
    .bind(lang)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Verified units of public letters whose audio is not ready yet. */
export async function countUnitsWithoutAudio(db: D1Database, lang: Unit["lang"]): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM units u JOIN letters l ON l.id = u.letter_id
       WHERE u.lang = ? AND u.verified = 1 AND u.audio_ready = 0 AND l.status = 'public'`,
    )
    .bind(lang)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Units stored since the JST day began: what `UNIT_DAILY_LIMIT` counts. */
export async function countUnitsToday(db: D1Database, now: Date = new Date()): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM units WHERE created_at >= ?").bind(jstDayStartIso(now)).first<{ n: number }>();
  return row?.n ?? 0;
}
