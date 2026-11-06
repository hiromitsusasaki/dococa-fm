/** A claim older than this is a synthesis that died with its isolate: treated as free. */
export const CLAIM_TTL_MS = 60_000;

/**
 * Claims `key` for synthesis: true for the one caller that may call the paid API, false while someone else
 * holds it. A claim older than `ttlMs` is stale and cleared first, in the same batch.
 */
export async function claimTts(db: D1Database, key: string, now = Date.now(), ttlMs = CLAIM_TTL_MS): Promise<boolean> {
  const [, insert] = await db.batch([
    db.prepare("DELETE FROM tts_claims WHERE key = ? AND created_at < ?").bind(key, now - ttlMs),
    db.prepare("INSERT OR IGNORE INTO tts_claims (key, created_at) VALUES (?, ?)").bind(key, now),
  ]);
  return (insert?.meta.changes ?? 0) === 1;
}

export async function releaseTts(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM tts_claims WHERE key = ?").bind(key).run();
}
