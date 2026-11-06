import type { Item, Letter } from "../types";
import { getItemsByIds } from "./items";
import { getLettersByIds } from "./letters";

export type HeardLetter = {
  episodeId: string;
  /** Position in the segments the episode page plays (the public view the player held when it started the letter). */
  segmentIndex: number;
  heardAt: string;
  letter: Letter;
  item: Item;
};

type ListenRow = { episode_id: string; letter_id: string; segment_index: number; heard_at: string };

/** The letter began playing for this listener. A letter heard again moves its row to the newest episode and time. */
export async function recordListen(
  db: D1Database,
  r: { listenerId: string; episodeId: string; letterId: string; segmentIndex: number; heardAt?: string },
): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO listens (listener_id, episode_id, letter_id, segment_index, heard_at) VALUES (?, ?, ?, ?, ?)")
    .bind(r.listenerId, r.episodeId, r.letterId, r.segmentIndex, r.heardAt ?? new Date().toISOString())
    .run();
}

/** The letters the listener heard, newest first. A letter that is no longer public is left out before the limit applies. */
export async function listHeardLetters(db: D1Database, listenerId: string, limit = 50): Promise<HeardLetter[]> {
  const { results } = await db
    .prepare(
      `SELECT s.episode_id, s.letter_id, s.segment_index, s.heard_at FROM listens s
       JOIN letters l ON l.id = s.letter_id
       WHERE s.listener_id = ? AND l.status = 'public'
       ORDER BY s.heard_at DESC, s.letter_id LIMIT ?`,
    )
    .bind(listenerId, limit)
    .all<ListenRow>();
  const letters = await getLettersByIds(db, results.map((r) => r.letter_id));
  const items = await getItemsByIds(db, [...letters.values()].map((l) => l.itemId));
  return results.flatMap((r) => {
    const letter = letters.get(r.letter_id);
    const item = letter && items.get(letter.itemId);
    return letter && item ? [{ episodeId: r.episode_id, segmentIndex: r.segment_index, heardAt: r.heard_at, letter, item }] : [];
  });
}
