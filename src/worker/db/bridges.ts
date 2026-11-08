import type { Lang } from "../i18n/t";
import { OWN_VOICES_SQL } from "./letters";
import { jstDayStartIso } from "./episodes";
import { rowToItem } from "./items";
import type { Item } from "../types";

/** A far bridge as stored: what the screen shows and, when readings change it, what the voice says. */
export type StoredBridge = { text: string; spoken: string | null };

/** D1 binds at most 100 parameters per statement; two are the listener and the language. */
const IN_CHUNK = 90;

/** The listener's stored far bridges in `lang` for these works, keyed by item id. */
export async function getBridges(db: D1Database, listenerId: string, itemIds: readonly string[], lang: Lang): Promise<Map<string, StoredBridge>> {
  const out = new Map<string, StoredBridge>();
  const unique = [...new Set(itemIds)];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT item_id, text, spoken FROM bridges WHERE listener_id = ? AND lang = ? AND item_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(listenerId, lang, ...chunk)
      .all<{ item_id: string; text: string; spoken: string | null }>();
    for (const r of results) out.set(r.item_id, { text: r.text, spoken: r.spoken });
  }
  return out;
}

/** Stores a verified bridge; the first one written for its key stays. */
export async function insertBridge(db: D1Database, listenerId: string, itemId: string, lang: Lang, b: StoredBridge, now: Date = new Date()): Promise<void> {
  await db
    .prepare("INSERT INTO bridges (listener_id, item_id, lang, text, spoken, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(listener_id, item_id, lang) DO NOTHING")
    .bind(listenerId, itemId, lang, b.text, b.spoken, now.toISOString())
    .run();
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
