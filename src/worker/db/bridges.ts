import type { Lang } from "../i18n/t";
import { OWN_VOICES_SQL } from "./letters";
import { jstDayStartIso } from "./episodes";
import { rowToItem } from "./items";
import type { Item } from "../types";

/**
 * A far bridge as stored: what the screen shows, what the voice says when readings change it, and the listener's work
 * the line names (`namedItemId`; null only for a row from before it was kept).
 */
export type StoredBridge = { text: string; spoken: string | null; namedItemId: string | null };

/** D1 binds at most 100 parameters per statement; two are the listener and the language. */
const IN_CHUNK = 90;

/** The listener's stored far bridges in `lang` for these works, keyed by item id. */
export async function getBridges(db: D1Database, listenerId: string, itemIds: readonly string[], lang: Lang): Promise<Map<string, StoredBridge>> {
  const out = new Map<string, StoredBridge>();
  const unique = [...new Set(itemIds)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT item_id, text, spoken, named_item_id FROM bridges WHERE listener_id = ? AND lang = ? AND item_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(listenerId, lang, ...chunk)
      .all<{ item_id: string; text: string; spoken: string | null; named_item_id: string | null }>();
    for (const r of results) out.set(r.item_id, { text: r.text, spoken: r.spoken, namedItemId: r.named_item_id });
  }
  return out;
}

/** Stores a verified bridge, replacing the one for its key (written again once the work it named is no longer the listener's). */
export async function insertBridge(db: D1Database, listenerId: string, itemId: string, lang: Lang, b: StoredBridge, now: Date = new Date()): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bridges (listener_id, item_id, lang, text, spoken, named_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(listener_id, item_id, lang) DO UPDATE SET text = excluded.text, spoken = excluded.spoken, named_item_id = excluded.named_item_id, created_at = excluded.created_at`,
    )
    .bind(listenerId, itemId, lang, b.text, b.spoken, b.namedItemId, now.toISOString())
    .run();
}

/** Which of `itemIds` are still among the works the listener spoke about themselves (`OWN_VOICES_SQL`). */
export async function ownWorksAmong(db: D1Database, listenerId: string, itemIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(itemIds)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT DISTINCT v.item_id FROM (${OWN_VOICES_SQL}) v WHERE v.item_id IN (${chunk.map((_, k) => `?${k + 2}`).join(", ")})`)
      .bind(listenerId, ...chunk)
      .all<{ item_id: string }>();
    for (const r of results) out.add(r.item_id);
  }
  return out;
}

/** Bridges written since the start of today (JST), everyone together. */
export async function countBridgesToday(db: D1Database, now: Date = new Date()): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM bridges WHERE created_at >= ?").bind(jstDayStartIso(now)).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Up to `limit` works the listener spoke about themselves (`OWN_VOICES_SQL`), the most recent first. */
export async function listOwnWorks(db: D1Database, listenerId: string, limit = 3): Promise<Item[]> {
  const { results } = await db
    .prepare(
      `SELECT i.* FROM (SELECT v.item_id, MAX(v.created_at) AS at FROM (${OWN_VOICES_SQL}) v GROUP BY v.item_id ORDER BY at DESC, v.item_id LIMIT ?2) f
       JOIN items i ON i.id = f.item_id ORDER BY f.at DESC, f.item_id`,
    )
    .bind(listenerId, limit)
    .all<Record<string, unknown>>();
  return results.map(rowToItem);
}
