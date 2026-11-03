import type { HistoryRow, Item } from "../types";
import { rowToItem } from "./items";

type Row = Record<string, unknown>;

export async function upsertHistory(db: D1Database, rows: HistoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO history (listener_id, item_id, source, occurred_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (listener_id, item_id) DO UPDATE SET
       source = excluded.source,
       occurred_at = COALESCE(excluded.occurred_at, history.occurred_at)`,
  );
  await db.batch(rows.map((r) => stmt.bind(r.listenerId, r.itemId, r.source, r.occurredAt)));
}

export async function isInHistory(db: D1Database, listenerId: string, itemId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS hit FROM history WHERE listener_id = ? AND item_id = ?").bind(listenerId, itemId).first();
  return row !== null;
}

export async function listHistory(
  db: D1Database,
  listenerId: string,
  limit: number,
): Promise<(HistoryRow & { item: Item })[]> {
  const { results } = await db
    .prepare(
      `SELECT h.listener_id, h.item_id, h.source, h.occurred_at,
              i.id, i.kind, i.title, i.creator, i.year, i.image_url, i.preview_url,
              i.out_links, i.external_ids, i.created_at
       FROM history h JOIN items i ON i.id = h.item_id
       WHERE h.listener_id = ?
       ORDER BY h.occurred_at IS NULL, h.occurred_at DESC, h.item_id
       LIMIT ?`,
    )
    .bind(listenerId, limit)
    .all<Row>();
  return results.map((r) => ({
    listenerId: r.listener_id as string,
    itemId: r.item_id as string,
    source: r.source as HistoryRow["source"],
    occurredAt: (r.occurred_at as string | null) ?? null,
    item: rowToItem(r),
  }));
}
