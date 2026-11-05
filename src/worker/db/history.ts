import type { HistoryRow, Item } from "../types";
import { rowToItem } from "./items";

type Row = Record<string, unknown>;

/** Five columns a row, and D1 binds at most 100 parameters per statement. */
const ROWS_PER_UPSERT = 20;

/** One multi-row statement per 20 rows, sent as one batch. */
export async function upsertHistory(db: D1Database, rows: HistoryRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_UPSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_UPSERT);
    stmts.push(
      db
        .prepare(
          `INSERT INTO history (listener_id, item_id, source, occurred_at, rank) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
           ON CONFLICT (listener_id, item_id) DO UPDATE SET
             source = excluded.source,
             occurred_at = COALESCE(excluded.occurred_at, history.occurred_at),
             rank = COALESCE(excluded.rank, history.rank)`,
        )
        .bind(...chunk.flatMap((r) => [r.listenerId, r.itemId, r.source, r.occurredAt, r.rank])),
    );
  }
  await db.batch(stmts);
}

export async function isInHistory(db: D1Database, listenerId: string, itemId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS hit FROM history WHERE listener_id = ? AND item_id = ?").bind(listenerId, itemId).first();
  return row !== null;
}

// The favourites predicate (source IN manual/url) and rank order are repeated in OWNER_FAVORITES_SQL (program/select-sql.ts); keep them in step.
const ORDER = {
  recent: "h.occurred_at IS NULL, h.occurred_at DESC, h.item_id",
  rank: "h.rank IS NULL, h.rank ASC, h.occurred_at DESC, h.item_id",
} as const;

function selectHistory(where: string, order: string): string {
  return `SELECT h.listener_id, h.item_id, h.source, h.occurred_at, h.rank,
              i.id, i.kind, i.title, i.creator, i.year, i.image_url, i.preview_url,
              i.out_links, i.external_ids, i.created_at
       FROM history h JOIN items i ON i.id = h.item_id
       WHERE h.listener_id = ?${where}
       ORDER BY ${order}
       LIMIT ?`;
}

function rowToHistory(r: Row): HistoryRow & { item: Item } {
  return {
    listenerId: r.listener_id as string,
    itemId: r.item_id as string,
    source: r.source as HistoryRow["source"],
    occurredAt: (r.occurred_at as string | null) ?? null,
    rank: (r.rank as number | null) ?? null,
    item: rowToItem(r),
  };
}

export async function listHistory(
  db: D1Database,
  listenerId: string,
  limit: number,
  order: "recent" | "rank" = "recent",
): Promise<(HistoryRow & { item: Item })[]> {
  const { results } = await db.prepare(selectHistory("", ORDER[order])).bind(listenerId, limit).all<Row>();
  return results.map(rowToHistory);
}

/** What the listener chose themselves (typed in or pasted), not what a service played, most loved first. */
export async function listFavorites(db: D1Database, listenerId: string, limit: number): Promise<(HistoryRow & { item: Item })[]> {
  const { results } = await db
    .prepare(selectHistory(" AND h.source IN ('manual', 'url')", ORDER.rank))
    .bind(listenerId, limit)
    .all<Row>();
  return results.map(rowToHistory);
}
