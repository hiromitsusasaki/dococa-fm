import { getLettersByIds } from "../db/letters";
import type { Episode, Letter, ScriptLine, Segment } from "../types";

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
  for (const l of letters.values()) if (l.status === "public" && l.lang !== "ja") out[l.id] = { body: l.body, lang: l.lang };
  return out;
}

export type PublicView = {
  segments: Segment[];
  /** For each line of `segments` in reading order, its index across the stored episode (the TTS cache key). */
  storedIndex: number[];
};

const isFixed = (l: ScriptLine | undefined): boolean => l?.type === "dj" && l.fixed === true;

/**
 * A stored episode as it may still be shown, read or voiced: a letter that is no longer public (rejected,
 * taken down, gone) is dropped with the fixed line that introduced it (a found voice's source line, a
 * reply's 「一言が届いています」). A segment left with none of the letters it read (replies aside) is dropped
 * whole, since its DJ talk answered them. 私も reactions carry no letter id in the script and stay.
 */
export function publicView(segments: Segment[], letters: ReadonlyMap<string, Letter>): PublicView {
  const out: Segment[] = [];
  const storedIndex: number[] = [];
  let base = 0;
  for (const seg of segments) {
    const keep = seg.lines.map(() => true);
    let had = 0;
    let gone = 0;
    seg.lines.forEach((line, i) => {
      if (line.type !== "letter") return;
      const read = line.kind !== "reply";
      if (read) had++;
      if (letters.get(line.letterId)?.status === "public") return;
      if (read) gone++;
      keep[i] = false;
      if ((line.kind === "found" || line.kind === "reply") && isFixed(seg.lines[i - 1])) keep[i - 1] = false;
    });
    if (!(had > 0 && gone === had)) {
      const lines: ScriptLine[] = [];
      seg.lines.forEach((line, i) => {
        if (!keep[i]) return;
        lines.push(line);
        storedIndex.push(base + i);
      });
      out.push({ ...seg, lines });
    }
    base += seg.lines.length;
  }
  return { segments: out, storedIndex };
}

/** Loads the letters an episode reads and returns what may still air of it, plus the originals to show. */
export async function loadPublicEpisode(db: D1Database, episode: Episode): Promise<PublicView & { letters: Map<string, Letter>; originals: Originals }> {
  const letters = await lettersOf(db, episode);
  return { ...publicView(episode.segments, letters), letters, originals: originalsOf(letters) };
}
