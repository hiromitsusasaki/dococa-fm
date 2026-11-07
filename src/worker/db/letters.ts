import type { Item, Letter, LetterKind } from "../types";
import { rowToItem } from "./items";
import { jstDayStartIso } from "./episodes";

type Row = Record<string, unknown>;

function rowToLetter(r: Row): Letter {
  return {
    id: r.id as string,
    itemId: r.item_id as string,
    kind: r.kind as LetterKind,
    body: r.body as string,
    bodyJa: r.body_ja as string,
    bodyEn: (r.body_en as string | null) ?? null,
    lang: r.lang as string,
    radioName: r.radio_name as string,
    place: r.place as string,
    placeCountry: (r.place_country as string | null) ?? null,
    placeRegion: (r.place_region as string | null) ?? null,
    year: (r.year as number | null) ?? null,
    listenerId: (r.listener_id as string | null) ?? null,
    parentLetterId: (r.parent_letter_id as string | null) ?? null,
    sourceUrl: (r.source_url as string | null) ?? null,
    sourceAuthor: (r.source_author as string | null) ?? null,
    status: r.status as Letter["status"],
    demo: r.demo === 1,
    createdAt: r.created_at as string,
  };
}

/** Every read of letters joins the listener, so a letter knows whether a demo account sent it. */
const SELECT = "SELECT letters.*, COALESCE(listeners.demo, 0) AS demo FROM letters LEFT JOIN listeners ON listeners.id = letters.listener_id";

export async function insertLetter(db: D1Database, l: Omit<Letter, "id" | "createdAt" | "demo">): Promise<Letter> {
  const letter = { ...l, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await db
    .prepare(
      `INSERT INTO letters (id, item_id, kind, body, body_ja, body_en, lang, radio_name, place, place_country, place_region, year,
         listener_id, parent_letter_id, source_url, source_author, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      letter.id,
      letter.itemId,
      letter.kind,
      letter.body,
      letter.bodyJa,
      letter.bodyEn,
      letter.lang,
      letter.radioName,
      letter.place,
      letter.placeCountry,
      letter.placeRegion,
      letter.year,
      letter.listenerId,
      letter.parentLetterId,
      letter.sourceUrl,
      letter.sourceAuthor,
      letter.status,
      letter.createdAt,
    )
    .run();
  const stored = await getLetter(db, letter.id);
  if (!stored) throw new Error(`letter ${letter.id} vanished after insert`);
  return stored;
}

export async function getLetter(db: D1Database, id: string): Promise<Letter | null> {
  const row = await db.prepare(`${SELECT} WHERE letters.id = ?`).bind(id).first<Row>();
  return row ? rowToLetter(row) : null;
}

/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 90;

/** Letters by id in one statement per 90 ids, whatever their status; missing ids are simply absent. */
export async function getLettersByIds(db: D1Database, ids: Iterable<string>): Promise<Map<string, Letter>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Letter>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`${SELECT} WHERE letters.id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<Row>();
    for (const r of results) out.set(r.id as string, rowToLetter(r));
  }
  return out;
}

/** The newest public letters (not 私も / 一言), each with its work; a found voice counts only with its source. One query. */
export async function listRecentPublicLetters(db: D1Database, limit = 6): Promise<Array<Letter & { item: Item }>> {
  const { results } = await db
    .prepare(
      `SELECT letters.*, COALESCE(listeners.demo, 0) AS demo,
         items.id AS i_id, items.kind AS i_kind, items.title AS i_title, items.creator AS i_creator, items.year AS i_year,
         items.image_url AS i_image_url, items.preview_url AS i_preview_url, items.out_links AS i_out_links,
         items.external_ids AS i_external_ids, items.created_at AS i_created_at
       FROM letters
       JOIN items ON items.id = letters.item_id
       LEFT JOIN listeners ON listeners.id = letters.listener_id
       WHERE letters.status = 'public'
         AND (letters.kind = 'letter' OR (letters.kind = 'found' AND TRIM(COALESCE(letters.source_url, '')) <> '' AND TRIM(COALESCE(letters.source_author, '')) <> ''))
       ORDER BY letters.created_at DESC, letters.id
       LIMIT ?`,
    )
    .bind(Math.max(0, Math.min(limit, 20)))
    .all<Row>();
  return results.map((r) => {
    const item = rowToItem({ id: r.i_id, kind: r.i_kind, title: r.i_title, creator: r.i_creator, year: r.i_year, image_url: r.i_image_url, preview_url: r.i_preview_url, out_links: r.i_out_links, external_ids: r.i_external_ids, created_at: r.i_created_at });
    return { ...rowToLetter(r), item };
  });
}

/** A public letter, or a found voice with its source, and its work's title, for a link preview; null for anything else. One query. */
export async function getPublicLetterWithTitle(db: D1Database, id: string): Promise<{ letter: Letter; title: string; imageUrl: string | null } | null> {
  const row = await db
    .prepare(
      `SELECT letters.*, COALESCE(listeners.demo, 0) AS demo, items.title AS i_title, items.image_url AS i_image
       FROM letters
       JOIN items ON items.id = letters.item_id
       LEFT JOIN listeners ON listeners.id = letters.listener_id
       WHERE letters.id = ? AND letters.status = 'public'
         AND (letters.kind = 'letter' OR (letters.kind = 'found' AND TRIM(COALESCE(letters.source_url, '')) <> '' AND TRIM(COALESCE(letters.source_author, '')) <> ''))`,
    )
    .bind(id)
    .first<Row>();
  return row ? { letter: rowToLetter(row), title: row.i_title as string, imageUrl: (row.i_image as string | null) ?? null } : null;
}

export async function listLettersForItem(db: D1Database, itemId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE letters.item_id = ? AND letters.status = 'public' ORDER BY letters.created_at ASC, letters.id ASC`)
    .bind(itemId)
    .all<Row>();
  return results.map(rowToLetter);
}

/** Source urls of every found voice of the item, whatever its status, so a rejected one is never collected again. */
export async function listFoundSources(db: D1Database, itemId: string): Promise<Array<{ id: string; sourceUrl: string }>> {
  const { results } = await db
    .prepare("SELECT id, source_url FROM letters WHERE item_id = ? AND kind = 'found' AND source_url IS NOT NULL")
    .bind(itemId)
    .all<{ id: string; source_url: string }>();
  return results.map((r) => ({ id: r.id, sourceUrl: r.source_url }));
}

export async function listLettersByListener(db: D1Database, listenerId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE letters.listener_id = ? ORDER BY letters.created_at DESC, letters.id DESC`)
    .bind(listenerId)
    .all<Row>();
  return results.map(rowToLetter);
}

/** Public 私も and 一言 that others left on the listener's public letters about any of the items, newest first. */
export async function listReactionsToListener(db: D1Database, listenerId: string, itemIds: string[]): Promise<Letter[]> {
  const out: Letter[] = [];
  for (let i = 0; i < itemIds.length; i += IN_CHUNK) {
    const chunk = itemIds.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(
        `${SELECT} JOIN letters p ON p.id = letters.parent_letter_id
         WHERE p.listener_id = ? AND p.status = 'public' AND letters.status = 'public'
           AND letters.kind IN ('watashimo', 'reply') AND (letters.listener_id IS NULL OR letters.listener_id != ?)
           AND letters.item_id IN (${chunk.map(() => "?").join(", ")})
         ORDER BY letters.created_at DESC, letters.id DESC`,
      )
      .bind(listenerId, listenerId, ...chunk)
      .all<Row>();
    out.push(...results.map(rowToLetter));
  }
  return out;
}

/** The newest public 私も and 一言 that others left on the listener's public letters, whatever the item. One query, cut in SQL. */
export async function listRecentReactionsToListener(db: D1Database, listenerId: string, limit: number): Promise<Letter[]> {
  const { results } = await db
    .prepare(
      `${SELECT} JOIN letters p ON p.id = letters.parent_letter_id
       WHERE p.listener_id = ?1 AND p.status = 'public' AND letters.status = 'public'
         AND letters.kind IN ('watashimo', 'reply') AND (letters.listener_id IS NULL OR letters.listener_id != ?1)
       ORDER BY letters.created_at DESC, letters.id DESC
       LIMIT ?2`,
    )
    .bind(listenerId, limit)
    .all<Row>();
  return results.map(rowToLetter);
}

/**
 * Whether someone left a 私も or 一言 on one of the listener's public letters since they last opened /me (the same reactions
 * `listRecentReactionsToListener` lists). One statement, for the header's dot.
 */
export async function hasUnseenReactions(db: D1Database, listenerId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM letters r
       JOIN letters p ON p.id = r.parent_letter_id
       JOIN listeners me ON me.id = p.listener_id
       WHERE p.listener_id = ?1 AND p.status = 'public' AND r.status = 'public'
         AND r.kind IN ('watashimo', 'reply') AND (r.listener_id IS NULL OR r.listener_id != ?1)
         AND r.created_at > COALESCE(me.reactions_seen_at, '1970')
       LIMIT 1`,
    )
    .bind(listenerId)
    .first();
  return row !== null;
}

export async function listReactionsForLetter(db: D1Database, letterId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE letters.parent_letter_id = ? AND letters.status = 'public' ORDER BY letters.created_at ASC, letters.id ASC`)
    .bind(letterId)
    .all<Row>();
  return results.map(rowToLetter);
}

/**
 * Letters and replies stored since the JST day began: what `LETTER_GLOBAL_DAILY_LIMIT` counts. Only they cost
 * a moderation and translation call; 私も and found voices are left out.
 */
export async function countLettersToday(db: D1Database, now: Date = new Date()): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM letters WHERE created_at >= ? AND kind IN ('letter', 'reply')").bind(jstDayStartIso(now)).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countRecentDuplicate(
  db: D1Database,
  listenerId: string,
  body: string,
  minutes: number,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - minutes * 60_000).toISOString();
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM letters WHERE listener_id = ? AND body = ? AND created_at >= ?")
    .bind(listenerId, body, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function setLetterStatus(db: D1Database, id: string, status: Letter["status"]): Promise<void> {
  await db.prepare("UPDATE letters SET status = ? WHERE id = ?").bind(status, id).run();
}

/** The listener's own public letters (kind `letter` only), newest first: what /me lets them take back. */
export async function listOwnPublicLetters(db: D1Database, listenerId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE letters.listener_id = ? AND letters.kind = 'letter' AND letters.status = 'public' ORDER BY letters.created_at DESC, letters.id DESC`)
    .bind(listenerId)
    .all<Row>();
  return results.map(rowToLetter);
}

/** The sender takes a public letter back. One write that checks owner, kind and status; false when it matched none. */
export async function withdrawLetter(db: D1Database, id: string, listenerId: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE letters SET status = 'withdrawn' WHERE id = ? AND listener_id = ? AND kind = 'letter' AND status = 'public'")
    .bind(id, listenerId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function insertReport(
  db: D1Database,
  r: { letterId: string; listenerId: string | null; reason: string },
): Promise<void> {
  await db
    .prepare("INSERT INTO reports (letter_id, listener_id, reason, created_at) VALUES (?, ?, ?, ?)")
    .bind(r.letterId, r.listenerId, r.reason, new Date().toISOString())
    .run();
}

export async function insertTakedown(db: D1Database, r: { url: string; reason: string }): Promise<void> {
  await db
    .prepare("INSERT INTO takedowns (url, reason, created_at) VALUES (?, ?, ?)")
    .bind(r.url, r.reason, new Date().toISOString())
    .run();
}

export async function hasWatashimo(db: D1Database, listenerId: string, parentLetterId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM letters WHERE listener_id = ? AND parent_letter_id = ? AND kind = 'watashimo' LIMIT 1")
    .bind(listenerId, parentLetterId)
    .first();
  return row !== null;
}

/**
 * The listener's (?1) own voices, one row per letter with the work it is about (`item_id`, `created_at`): their public
 * letters, and their public 私も and 一言 on someone else's public letter or on a found voice (answers on their own letter are
 * not a new voice; a found voice has no listener). The dial's taste is made from these works, and the dial
 * wakes once there are three. Never a favourite.
 */
export const OWN_VOICES_SQL = `SELECT l.item_id, l.created_at FROM letters l WHERE l.listener_id = ?1 AND l.status = 'public' AND l.kind = 'letter'
  UNION ALL
  SELECT p.item_id, r.created_at FROM letters r JOIN letters p ON p.id = r.parent_letter_id
  WHERE r.listener_id = ?1 AND r.status = 'public' AND r.kind IN ('watashimo', 'reply') AND p.status = 'public' AND (p.listener_id IS NULL OR p.listener_id <> ?1)`;

/** How many own voices (`OWN_VOICES_SQL`) the listener has: letters sent and reactions, in one statement. Never shown as a number. */
export async function countOwnLetters(db: D1Database, listenerId: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM (${OWN_VOICES_SQL})`).bind(listenerId).first<{ n: number }>();
  return row?.n ?? 0;
}
