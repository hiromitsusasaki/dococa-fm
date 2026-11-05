import { publicView } from "../program/stored";
import type { Item, Letter } from "../types";
import { listVerifiedEpisodes } from "./episodes";
import { getItemsByIds } from "./items";
import { getLettersByIds } from "./letters";

const EPISODE_WINDOW = 30;

export type HeardLetter = {
  episodeId: string;
  /** Position in the segments the episode page plays (letters that are no longer public are already left out). */
  segmentIndex: number;
  heardAt: string;
  letter: Letter;
  item: Item;
};

/** The letters the listener's recent verified episodes read aloud, newest first, one row per letter. */
export async function listHeardLetters(db: D1Database, listenerId: string, limit = 50): Promise<HeardLetter[]> {
  const episodes = await listVerifiedEpisodes(db, listenerId, EPISODE_WINDOW);
  const ids = episodes.flatMap((e) => e.segments.flatMap((s) => s.lines.flatMap((l) => (l.type === "letter" && l.kind !== "reply" ? [l.letterId] : []))));
  const letters = await getLettersByIds(db, ids);
  const seen = new Set<string>();
  const found: Array<{ episodeId: string; segmentIndex: number; heardAt: string; letter: Letter }> = [];
  for (const e of episodes) {
    publicView(e.segments, letters).segments.forEach((seg, segmentIndex) => {
      for (const line of seg.lines) {
        if (line.type !== "letter" || line.kind === "reply" || seen.has(line.letterId)) continue;
        const letter = letters.get(line.letterId);
        if (!letter || letter.status !== "public") continue;
        seen.add(line.letterId);
        found.push({ episodeId: e.id, segmentIndex, heardAt: e.createdAt, letter });
      }
    });
  }
  const rows = found.slice(0, limit);
  const items = await getItemsByIds(db, rows.map((r) => r.letter.itemId));
  return rows.flatMap((r) => {
    const item = items.get(r.letter.itemId);
    return item ? [{ ...r, item }] : [];
  });
}
