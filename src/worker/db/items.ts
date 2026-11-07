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
    ...(typeof r.reading_ja === "string" ? { readingJa: JSON.parse(r.reading_ja) as NonNullable<Item["readingJa"]> } : {}),
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

/**
 * Stores how the Japanese voice says the work's title and creator, laid over what the work had (a field given
 * replaces that field; one not given stays): the most recent verified unit that gives a reading sets it. When the
 * reading changes, the work's Japanese units are marked to be voiced again, since their lead clips said the old
 * one. Nothing when both are absent. One batch.
 */
export async function setItemReading(db: D1Database, id: string, reading: NonNullable<Item["readingJa"]>): Promise<void> {
  const value: NonNullable<Item["readingJa"]> = { ...(reading.title ? { title: reading.title } : {}), ...(reading.creator ? { creator: reading.creator } : {}) };
  if (Object.keys(value).length === 0) return;
  const patch = JSON.stringify(value);
  const changed = "reading_ja IS NULL OR json_patch(reading_ja, ?) <> json(reading_ja)";
  await db.batch([
    db
      .prepare(
        `UPDATE units SET audio_ready = 0 WHERE lang = 'ja' AND audio_ready = 1
           AND letter_id IN (SELECT l.id FROM letters l WHERE l.item_id = ?)
           AND EXISTS (SELECT 1 FROM items WHERE id = ? AND (${changed}))`,
      )
      .bind(id, id, patch),
    db.prepare(`UPDATE items SET reading_ja = json_patch(COALESCE(reading_ja, '{}'), ?) WHERE id = ? AND (${changed})`).bind(patch, id, patch),
  ]);
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

/** Dimensions of a work vector (bge-m3). */
export const VEC_DIMS = 1024;

/** Scales a vector to unit length; a zero vector stays zero. */
export function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  if (len === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / len;
  return out;
}

/** A unit vector as Int8 (`round(x × 127)`), one byte a dimension. */
export function quantise(v: Float32Array): Uint8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((v[i] as number) * 127)));
  return new Uint8Array(q.buffer);
}

/** D1 hands a BLOB back as an ArrayBuffer or as an array of byte values; either way it is read as Int8 and scaled back to unit length. */
export function dequantise(raw: unknown): Float32Array | null {
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : Array.isArray(raw) ? Uint8Array.from(raw as number[]) : null;
  if (!bytes || bytes.length === 0) return null;
  const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) v[i] = (q[i] as number) / 127;
  return normalise(v);
}

/** Dequantised vectors kept per isolate, oldest dropped first past the cap. A vector only changes through `setItemVecs`. */
const VEC_CACHE_MAX = 2000;
const vecCache = new Map<string, Float32Array>();
function cacheVec(id: string, v: Float32Array): void {
  vecCache.delete(id);
  vecCache.set(id, v);
  while (vecCache.size > VEC_CACHE_MAX) vecCache.delete(vecCache.keys().next().value as string);
}

/** Stores many vectors in one batch. */
export async function setItemVecs(db: D1Database, entries: Array<[string, Float32Array]>): Promise<void> {
  if (entries.length === 0) return;
  const unit = entries.map(([id, v]) => [id, normalise(v)] as const);
  await db.batch(unit.map(([id, v]) => db.prepare("UPDATE items SET vec = ? WHERE id = ?").bind(quantise(v), id)));
  // What is cached is what a read would give back: the quantised vector, not the exact one.
  for (const [id, v] of unit) {
    const back = dequantise(quantise(v));
    if (back) cacheVec(id, back);
  }
}

export async function setItemVec(db: D1Database, id: string, vec: Float32Array): Promise<void> {
  await setItemVecs(db, [[id, vec]]);
}

/** The vectors of the items that have one, dequantised; from the isolate cache first, the rest in one statement per 90 ids. */
export async function getItemVecs(db: D1Database, ids: Iterable<string>): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = vecCache.get(id);
    if (hit) out.set(id, hit);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += IN_CHUNK) {
    const chunk = missing.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT id, vec FROM items WHERE vec IS NOT NULL AND id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ id: string; vec: unknown }>();
    for (const r of results) {
      const v = dequantise(r.vec);
      if (!v) continue;
      out.set(r.id, v);
      cacheVec(r.id, v);
    }
  }
  return out;
}

/** Ids of items still without a vector, newest first. */
export async function listItemsWithoutVec(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db.prepare("SELECT id FROM items WHERE vec IS NULL ORDER BY created_at DESC, id LIMIT ?").bind(Math.max(0, limit)).all<{ id: string }>();
  return results.map((r) => r.id);
}

export async function countItemsWithoutVec(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM items WHERE vec IS NULL").first<{ n: number }>())?.n ?? 0;
}
