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
    createdAt: r.created_at as string,
  };
}

export async function insertLetter(db: D1Database, l: Omit<Letter, "id" | "createdAt">): Promise<Letter> {
  const letter: Letter = { ...l, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
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
  return letter;
}

export async function getLetter(db: D1Database, id: string): Promise<Letter | null> {
  const row = await db.prepare("SELECT * FROM letters WHERE id = ?").bind(id).first<Row>();
  return row ? rowToLetter(row) : null;
}

export async function listLettersForItem(db: D1Database, itemId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare("SELECT * FROM letters WHERE item_id = ? AND status = 'public' ORDER BY created_at ASC, id ASC")
    .bind(itemId)
    .all<Row>();
  return results.map(rowToLetter);
}

export async function listLettersByListener(db: D1Database, listenerId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare("SELECT * FROM letters WHERE listener_id = ? ORDER BY created_at DESC, id DESC")
    .bind(listenerId)
    .all<Row>();
  return results.map(rowToLetter);
}

export async function listReactionsForLetter(db: D1Database, letterId: string): Promise<Letter[]> {
  const { results } = await db
    .prepare("SELECT * FROM letters WHERE parent_letter_id = ? AND status = 'public' ORDER BY created_at ASC, id ASC")
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
