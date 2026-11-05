import { getItemsByIds } from "../db/items";
import { getLettersByIds, listReactionsToListener } from "../db/letters";
import type { Env } from "../env";
import { hasClaude } from "../claude/client";
import type { Episode, Item, Letter, Listener, VerifyReport } from "../types";
import { composeEpisode, MAX_REACTIONS, type SegmentPlan } from "./compose";
import { type DjLines, writeDjLines } from "./script";
import { selectProgram } from "./select";
import { verifyEpisode } from "./verify";

const DJ_ATTEMPTS = 2;
/** Checks a rephrased script can fix; verbatim and sources failures come from the data. */
const RETRYABLE = /^(?:topical|measure|pii|announce): /;

/** Even the readings-only episode failed verification: the data itself is bad, and nothing may air. */
export class EpisodeUnverifiedError extends Error {
  constructor(readonly report: VerifyReport) {
    super("episode unverified");
    this.name = "EpisodeUnverifiedError";
  }
}

const hasSource = (l: Letter) => l.kind !== "found" || (Boolean(l.sourceUrl?.trim()) && Boolean(l.sourceAuthor?.trim()));


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
 * select → write → compose → verify. A script that fails verification is asked for once more, told what
 * failed; if that one fails too, the episode is composed with fixed DJ phrases only. A found voice without
 * a source never enters. If even the fixed-phrase episode fails, `EpisodeUnverifiedError` is thrown so an
 * unverified episode can never be returned. Not inserted here.
 */
export async function buildEpisode(
  env: Env,
  db: D1Database,
  listener: Listener,
  opts: { size?: number; seed?: string } = {},
): Promise<Episode> {
  const selection = await selectProgram(db, listener, opts);
  // Three reads for the whole plan, whatever its size: D1 counts queries per invocation.
  const itemIds = selection.map((s) => s.itemId);
  const [stored, candidates, allReactions] = await Promise.all([
    getItemsByIds(db, itemIds),
    getLettersByIds(db, selection.flatMap((s) => s.letterIds)),
    listReactionsToListener(db, listener.id, itemIds),
  ]);
  const items = new Map<string, Item>();
  const letters = new Map<string, Letter>();
  const plan: SegmentPlan[] = [];
  const input: Parameters<typeof writeDjLines>[1] = { listener, segments: [] };
  let sourceless = 0;

  for (const s of selection) {
    const item = stored.get(s.itemId);
    if (!item) continue;
    items.set(item.id, item);
    const read: Letter[] = [];
    for (const id of s.letterIds) {
      const l = candidates.get(id);
      if (l && l.status === "public" && !hasSource(l)) sourceless++;
      else if (l && l.status === "public") {
        letters.set(l.id, l);
        read.push(l);
      }
    }
    // Public 私も and 一言 that others left on this listener's letters about the item, newest first.
    const reactions = allReactions.filter((r) => r.itemId === item.id).slice(0, MAX_REACTIONS);
    for (const r of reactions) letters.set(r.id, r);
    plan.push({ ...s, letterIds: read.map((l) => l.id), reactionIds: reactions.map((r) => r.id) });
    input.segments.push({ item, slot: s.slot, letters: read, reactions });
  }

  if (sourceless > 0) console.warn(`[dococa] skipped ${sourceless} found voice(s) without a source; fix the data`);

  const finish = (segments: Episode["segments"]): Episode => {
    const report = verifyEpisode(segments, letters, listener, items);
    const verified = report.verbatim && report.sources && report.topical && report.pii;
    return { id: crypto.randomUUID(), listenerId: listener.id, segments, verified, report, cloudTts: false, createdAt: new Date().toISOString() };
  };

  if (plan.length > 0 && hasClaude(env)) {
    let retryNotes: string[] | undefined;
    for (let attempt = 0; attempt < DJ_ATTEMPTS; attempt++) {
      const djLines = await askDj(env, { ...input, retryNotes });
      if (!djLines) break;
      const episode = finish(composeEpisode(plan, djLines, letters, items));
      if (episode.verified) return episode;
      console.warn("[dococa] dj script failed verification", episode.report.details.join("; "));
      retryNotes = episode.report.details.filter((d) => RETRYABLE.test(d));
    }
  } else if (plan.length > 0) {
    console.warn("[dococa] ANTHROPIC_API_KEY is empty; reading letters only");
  }
  const readings = finish(composeEpisode(plan, null, letters, items));
  if (!readings.verified) throw new EpisodeUnverifiedError(readings.report);
  return readings;
}
