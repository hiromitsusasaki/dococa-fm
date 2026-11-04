import type { Letter, LetterKind } from "../types";

type Row = Record<string, unknown>;

function rowToLetter(r: Row): Letter {
  return {
    id: r.id as string,
    itemId: r.item_id as string,
    kind: r.kind as LetterKind,
    body: r.body as string,
    bodyJa: r.body_ja as string,
    lang: r.lang as string,
    radioName: r.radio_name as string,
    place: r.place as string,
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
      `INSERT INTO letters (id, item_id, kind, body, body_ja, lang, radio_name, place, year,
         listener_id, parent_letter_id, source_url, source_author, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      letter.id,
      letter.itemId,
      letter.kind,
      letter.body,
      letter.bodyJa,
      letter.lang,
      letter.radioName,
      letter.place,
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

export async function listReactionsForLetter(db: D1Database, letterId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare(`${SELECT} WHERE letters.parent_letter_id = ? AND letters.status = 'public' ORDER BY letters.created_at ASC, letters.id ASC`)
    .bind(letterId)
    .all<Row>();
  return results.map(rowToLetter);
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
