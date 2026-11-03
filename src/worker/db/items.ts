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

export async function insertItem(db: D1Database, draft: Omit<Item, "id" | "createdAt">): Promise<Item> {
  const item: Item = { ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await db
    .prepare(
      `INSERT INTO items (id, kind, title, creator, year, image_url, preview_url, out_links, external_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
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
    )
    .run();
  return item;
}

export async function getItem(db: D1Database, id: string): Promise<Item | null> {
  const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Row>();
  return row ? rowToItem(row) : null;
}

export async function findItemByExternalId(db: D1Database, key: string, value: string): Promise<Item | null> {
  if (!/^[a-z-]+$/.test(key)) throw new Error(`invalid external id key: ${key}`);
  const row = await db
    .prepare("SELECT * FROM items WHERE json_extract(external_ids, '$.' || ?) = ? LIMIT 1")
    .bind(key, value)
    .first<Row>();
  return row ? rowToItem(row) : null;
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
