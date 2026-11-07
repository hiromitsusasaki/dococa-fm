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

/**
 * `audio_ready = 2`: a line of the unit gave up (`ensureAudio` answered `gaveUp`), so the batch stops voicing it
 * and the player reads that line in the browser voice. Same guard as `setUnitAudioReady`; a remake resets it to 0.
 */
export async function setUnitAudioGaveUp(db: D1Database, letterId: string, lang: Unit["lang"], voiced: Pick<Unit, "intro" | "after">): Promise<void> {
  await db
    .prepare("UPDATE units SET audio_ready = 2 WHERE letter_id = ? AND lang = ? AND intro = ? AND after = ?")
    .bind(letterId, lang, voiced.intro, voiced.after)
    .run();
}

/** Verified units of public letters marked as given up (`audio_ready = 2`). */
export async function countUnitsGaveUp(db: D1Database, lang: Unit["lang"]): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM units u JOIN letters l ON l.id = u.letter_id
       WHERE u.lang = ? AND u.verified = 1 AND u.audio_ready = 2 AND l.status = 'public'`,
    )
    .bind(lang)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
 * Verified units whose audio is not ready yet, oldest first (given-up units, `audio_ready = 2`, are left out).
 * Only units of letters still public: a letter rejected or taken down after its unit was made is never voiced.
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

/** Units stored since the JST day began, plus today's units the owner's remake removed: what `UNIT_DAILY_LIMIT` counts. One statement. */
export async function countUnitsToday(db: D1Database, now: Date = new Date()): Promise<number> {
  const since = jstDayStartIso(now);
  const row = await db
    .prepare("SELECT (SELECT COUNT(*) FROM units WHERE created_at >= ?) + (SELECT COUNT(*) FROM unit_remakes WHERE created_at >= ?) AS n")
    .bind(since, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A unit as the owner's admin page shows it: with the work's title, the letter's text and the owner's 👍. */
export type UnitRow = Unit & { liked: boolean; title: string; letterBody: string };

/** Units of public letters in `lang`, in letter id order after the `after` cursor, joined with their work and letter, for the owner's review. */
export async function listUnits(db: D1Database, opts: { lang: Unit["lang"]; limit: number; after?: string }): Promise<UnitRow[]> {
  const { results } = await db
    .prepare(
      `SELECT u.*, i.title AS title, l.body AS letter_body FROM units u
       JOIN letters l ON l.id = u.letter_id JOIN items i ON i.id = l.item_id
       WHERE u.lang = ? AND u.letter_id > ? AND l.status = 'public'
       ORDER BY u.letter_id ASC
       LIMIT ?`,
    )
    .bind(opts.lang, opts.after ?? "", opts.limit)
    .all<Row>();
  return results.map((r) => ({ ...rowToUnit(r), liked: r.liked === 1, title: r.title as string, letterBody: r.letter_body as string }));
}

/** The owner's 👍 on one unit, set to the given value (so a repeated form post does not flip it back). */
export async function setUnitLiked(db: D1Database, letterId: string, lang: Unit["lang"], liked: boolean): Promise<void> {
  await db.prepare("UPDATE units SET liked = ? WHERE letter_id = ? AND lang = ?").bind(liked ? 1 : 0, letterId, lang).run();
}

/** Liked, verified units of public letters in `lang`, newest first: the DJ prompt's examples. */
export async function listLikedUnits(db: D1Database, lang: Unit["lang"], limit: number): Promise<Unit[]> {
  const { results } = await db
    .prepare(
      `SELECT u.* FROM units u JOIN letters l ON l.id = u.letter_id
       WHERE u.lang = ? AND u.liked = 1 AND u.verified = 1 AND l.status = 'public'
       ORDER BY u.created_at DESC, u.letter_id DESC
       LIMIT ?`,
    )
    .bind(lang, limit)
    .all<Row>();
  return results.map(rowToUnit);
}

/**
 * The owner's remake: replaces the unit with new verified lines whatever the stored one is (the owner asked for it),
 * with `audio_ready` off so the next run voices the new text. The clips of the old text stay cached by text. A unit
 * made today is first noted in `unit_remakes`, so the call that made it still counts toward today's cap. One batch:
 * when it fails, the old row is as it was.
 */
export async function replaceUnit(db: D1Database, u: Pick<Unit, "letterId" | "lang" | "intro" | "after">, now: Date = new Date()): Promise<void> {
  const at = now.toISOString();
  await db.batch([
    db
      .prepare("INSERT INTO unit_remakes (letter_id, lang, created_at) SELECT letter_id, lang, ? FROM units WHERE letter_id = ? AND lang = ? AND created_at >= ?")
      .bind(at, u.letterId, u.lang, jstDayStartIso(now)),
    db
      .prepare(
        `INSERT INTO units (letter_id, lang, intro, after, verified, audio_ready, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)
         ON CONFLICT(letter_id, lang) DO UPDATE SET intro = excluded.intro, after = excluded.after, verified = 1, audio_ready = 0, created_at = excluded.created_at`,
      )
      .bind(u.letterId, u.lang, u.intro, u.after, at),
  ]);
}
