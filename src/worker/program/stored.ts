import { getLettersByIds } from "../db/letters";
import type { Episode, Letter } from "../types";

/** The untouched original of a letter that was not written in Japanese, keyed by letter id. */
export type Originals = Record<string, { body: string; lang: string }>;

export const letterIdsOf = (episode: Pick<Episode, "segments">): string[] =>
  episode.segments.flatMap((s) => s.lines.flatMap((l) => (l.type === "letter" ? [l.letterId] : [])));

/** The stored letters an episode reads, in one query. */
export const lettersOf = (db: D1Database, episode: Pick<Episode, "segments">): Promise<Map<string, Letter>> =>
  getLettersByIds(db, letterIdsOf(episode));

/** Originals shown beside the translation that is read aloud; the script itself carries only the translation. */
export function originalsOf(letters: ReadonlyMap<string, Letter>): Originals {
  const out: Originals = {};
  for (const l of letters.values()) if (l.lang !== "ja") out[l.id] = { body: l.body, lang: l.lang };
  return out;
}
