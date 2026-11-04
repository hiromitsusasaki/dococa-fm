import type { Item, ItemKind } from "../types";

type Row = Record<string, unknown>;

export function rowToItem(r: Row): Item {
  return {
    id: r.id as string,
    kind: r.kind as ItemKind,
    title: r.title as string,
    creator: r.creator as string,
    year: (r.year as number | null) ?? null,
    imageUrl: (r.image_url as string | null) ?? null,
    previewUrl: (r.preview_url as string | null) ?? null,
    outLinks: JSON.parse(r.out_links as string),
    externalIds: JSON.parse(r.external_ids as string),
    createdAt: r.created_at as string,
  };
}

const ITEM_COLUMNS = "(id, kind, title, creator, year, image_url, preview_url, out_links, external_ids, created_at)";
const itemValues = (item: Item): unknown[] => [
  item.id,
  item.kind,
  item.title,
  item.creator,
  item.year,
  item.imageUrl,
  item.previewUrl,
  JSON.stringify(item.outLinks),
  JSON.stringify(item.externalIds),
  item.createdAt,
];
/** Ten columns a row, and D1 binds at most 100 parameters per statement. */
const ITEMS_PER_INSERT = 9;

export const newItem = (draft: Omit<Item, "id" | "createdAt">): Item => ({ ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() });

export async function insertItem(db: D1Database, draft: Omit<Item, "id" | "createdAt">): Promise<Item> {
  const item = newItem(draft);
  await db.prepare(`INSERT INTO items ${ITEM_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...itemValues(item)).run();
  return item;
}

/** Stores many items with one multi-row statement per nine, sent as one batch. */
export async function insertItems(db: D1Database, items: Item[]): Promise<void> {
  if (items.length === 0) return;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < items.length; i += ITEMS_PER_INSERT) {
    const chunk = items.slice(i, i + ITEMS_PER_INSERT);
    const rows = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    stmts.push(db.prepare(`INSERT INTO items ${ITEM_COLUMNS} VALUES ${rows}`).bind(...chunk.flatMap(itemValues)));
  }
  await db.batch(stmts);
}

export async function getItem(db: D1Database, id: string): Promise<Item | null> {
  const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Row>();
  return row ? rowToItem(row) : null;
}

/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 90;

/** Items by id in one statement per 90 ids; missing ids are simply absent. */
export async function getItemsByIds(db: D1Database, ids: Iterable<string>): Promise<Map<string, Item>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, Item>();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT * FROM items WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<Row>();
    for (const r of results) out.set(r.id as string, rowToItem(r));
  }
  return out;
}

export async function findItemByExternalId(db: D1Database, key: string, value: string): Promise<Item | null> {
  if (!/^[a-z-]+$/.test(key)) throw new Error(`invalid external id key: ${key}`);
  const row = await db
    .prepare("SELECT * FROM items WHERE json_extract(external_ids, '$.' || ?) = ? LIMIT 1")
    .bind(key, value)
    .first<Row>();
  return row ? rowToItem(row) : null;
}

/** Two parameters a pair. */
const PAIRS_PER_LOOKUP = 45;

/** Every stored item holding any of the external ids, oldest first, in one statement per 45 pairs. */
export async function findItemsByExternalIds(db: D1Database, pairs: Array<[string, string]>): Promise<Item[]> {
  for (const [key] of pairs) if (!/^[a-z-]+$/.test(key)) throw new Error(`invalid external id key: ${key}`);
  const out = new Map<string, Item>();
  for (let i = 0; i < pairs.length; i += PAIRS_PER_LOOKUP) {
    const chunk = pairs.slice(i, i + PAIRS_PER_LOOKUP);
    const where = chunk.map(() => "json_extract(external_ids, '$.' || ?) = ?").join(" OR ");
    const { results } = await db
      .prepare(`SELECT * FROM items WHERE ${where} ORDER BY created_at, id`)
      .bind(...chunk.flat())
      .all<Row>();
    for (const r of results) out.set(r.id as string, rowToItem(r));
  }
  return [...out.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export async function searchItems(db: D1Database, q: string, limit: number): Promise<Item[]> {
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const { results } = await db
    .prepare(
      `SELECT * FROM items
       WHERE title LIKE ?1 ESCAPE '\\' OR creator LIKE ?1 ESCAPE '\\'
       ORDER BY created_at DESC, id
       LIMIT ?2`,
    )
    .bind(pattern, Math.max(0, Math.min(limit, 20)))
    .all<Row>();
  return results.map(rowToItem);
}

/** Newest first, only works with at least one public letter: a stored item alone has passed no judgement. */
export async function listRecentItems(db: D1Database, limit: number): Promise<Item[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM items
       WHERE EXISTS (SELECT 1 FROM letters WHERE letters.item_id = items.id AND letters.status = 'public')
       ORDER BY created_at DESC, id LIMIT ?`,
    )
    .bind(Math.max(0, Math.min(limit, 20)))
    .all<Row>();
  return results.map(rowToItem);
}
