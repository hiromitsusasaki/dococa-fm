import { getItem } from "../db/items";
import { getLetter, listLettersForItem } from "../db/letters";
import type { Env } from "../env";
import { hasClaude } from "../claude/client";
import type { Episode, Item, Letter, Listener } from "../types";
import { composeEpisode, MAX_REACTIONS, type SegmentPlan } from "./compose";
import { type DjLines, writeDjLines } from "./script";
import { selectProgram } from "./select";
import { verifyEpisode } from "./verify";

const DJ_ATTEMPTS = 2;

/** Public 私も and 一言 that others left on this listener's letters about the item, newest first. */
async function reactionsTo(db: D1Database, listener: Listener, itemId: string): Promise<Letter[]> {
  const onItem = await listLettersForItem(db, itemId);
  const mine = new Set(onItem.filter((l) => l.listenerId === listener.id).map((l) => l.id));
  return onItem
    .filter((l) => (l.kind === "watashimo" || l.kind === "reply") && l.parentLetterId !== null && mine.has(l.parentLetterId))
    .filter((l) => l.listenerId !== listener.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, MAX_REACTIONS);
}

async function askDj(env: Env, input: Parameters<typeof writeDjLines>[1]): Promise<DjLines[] | null> {
  try {
    return await writeDjLines(env, input);
  } catch (e) {
    const status = (e as { status?: unknown } | null)?.status;
    console.warn(
      "[dococa] dj script unavailable; reading letters only",
      typeof status === "number" ? `status ${status}` : "no status",
      e instanceof Error ? e.message : "unknown error",
    );
    return null;
  }
}

/**
 * select → write → compose → verify. A script that fails verification is asked for once more; if that one
 * fails too, the episode is composed with fixed DJ phrases only. Not inserted here.
 */
export async function buildEpisode(
  env: Env,
  db: D1Database,
  listener: Listener,
  opts: { size?: number; seed?: string } = {},
): Promise<Episode> {
  const selection = await selectProgram(db, listener, opts);
  const items = new Map<string, Item>();
  const letters = new Map<string, Letter>();
  const plan: SegmentPlan[] = [];
  const input: Parameters<typeof writeDjLines>[1] = { listener, segments: [] };

  for (const s of selection) {
    const item = await getItem(db, s.itemId);
    if (!item) continue;
    items.set(item.id, item);
    const read: Letter[] = [];
    for (const id of s.letterIds) {
      const l = await getLetter(db, id);
      if (l && l.status === "public") {
        letters.set(l.id, l);
        read.push(l);
      }
    }
    const reactions = await reactionsTo(db, listener, item.id);
    for (const r of reactions) letters.set(r.id, r);
    plan.push({ ...s, letterIds: read.map((l) => l.id), reactionIds: reactions.map((r) => r.id) });
    input.segments.push({ item, slot: s.slot, letters: read, reactions });
  }

  const finish = (segments: Episode["segments"]): Episode => {
    const report = verifyEpisode(segments, letters, listener, items);
    const verified = report.verbatim && report.sources && report.topical && report.pii;
    return { id: crypto.randomUUID(), listenerId: listener.id, segments, verified, report, createdAt: new Date().toISOString() };
  };

  if (plan.length > 0 && hasClaude(env)) {
    let retryNotes: string[] | undefined;
    for (let attempt = 0; attempt < DJ_ATTEMPTS; attempt++) {
      const djLines = await askDj(env, { ...input, retryNotes });
      if (!djLines) break;
      const episode = finish(composeEpisode(plan, djLines, letters, items));
      if (episode.verified) return episode;
      console.warn("[dococa] dj script failed verification", episode.report.details.join("; "));
      retryNotes = episode.report.details;
    }
  } else if (plan.length > 0) {
    console.warn("[dococa] ANTHROPIC_API_KEY is empty; reading letters only");
  }
  return finish(composeEpisode(plan, null, letters, items));
}
