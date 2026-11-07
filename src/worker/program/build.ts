import { getItemsByIds } from "../db/items";
import { getLettersByIds, listReactionsToListener } from "../db/letters";
import type { Env } from "../env";
import type { Episode, Item, Letter, Listener, Unit, VerifyReport } from "../types";
import { composeEpisode, MAX_REACTIONS, type SegmentPlan } from "./compose";
import { selectProgram } from "./select";
import type { StationKey } from "./station";
import { ensureUnits } from "./unit";
import { verifyEpisode } from "./verify";

/** Even the readings-only episode failed verification: the data itself is bad, and nothing may air. */
export class EpisodeUnverifiedError extends Error {
  constructor(readonly report: VerifyReport) {
    super("episode unverified");
    this.name = "EpisodeUnverifiedError";
  }
}

const hasSource = (l: Letter) => l.kind !== "found" || (Boolean(l.sourceUrl?.trim()) && Boolean(l.sourceAuthor?.trim()));

/** The 0-based segments a verify report names (`{check}: segment {i} line {j}: …`). */
function segmentsNamed(details: string[]): Set<number> {
  const out = new Set<number>();
  for (const d of details) {
    const m = d.match(/^\w+: segment (\d+) /);
    if (m) out.add(Number(m[1]) - 1);
  }
  return out;
}

/**
 * select → load → units → compose → verify. The DJ's talk comes from the letters' units (made here when
 * missing); a unit that verified alone can still fail inside this programme (quoting another letter of the
 * segment), so the units of the segments the report names are left out and the episode verified again,
 * then every unit is left out. The unit rows are never changed here. A found voice without a source never
 * enters. If even the fixed-phrase episode fails, `EpisodeUnverifiedError` is thrown so an unverified
 * episode can never be returned. Not inserted here.
 */
export async function buildEpisode(
  env: Env,
  db: D1Database,
  listener: Listener,
  /** `first`: the first programme of a visit, which the DJ opens (true unless said otherwise). */
  opts: { size?: number; seed?: string; station?: StationKey; dial?: number; letterId?: string; first?: boolean } = {},
): Promise<Episode> {
  // The programme is made in the listener's language: units, fixed lines, the letters' renderings and the checks.
  const lang = listener.lang;
  const selection = await selectProgram(db, listener, opts);
  // Three reads for the whole plan, whatever its size: D1 counts queries per invocation.
  const itemIds = selection.map((s) => s.itemId);
  // A public radio reads only the owner's own 一言 after a letter they answered; never reactions to the visitor's letters.
  const onPublic = opts.station?.kind === "public";
  const [stored, candidates, allReactions] = await Promise.all([
    getItemsByIds(db, itemIds),
    getLettersByIds(db, selection.flatMap((s) => [...s.letterIds, ...(s.ownerReplyIds ?? [])])),
    onPublic ? Promise.resolve([] as Letter[]) : listReactionsToListener(db, listener.id, itemIds),
  ]);
  const items = new Map<string, Item>();
  const letters = new Map<string, Letter>();
  const plan: SegmentPlan[] = [];
  let sourceless = 0;
  let skippedSegments = 0;

  for (const s of selection) {
    const item = stored.get(s.itemId);
    if (!item) continue;
    // On a public radio, the owner's 一言 on the letter. Elsewhere, public 私も and 一言 that others left on this listener's letters about the item, newest first.
    const ownerReplies = (s.ownerReplyIds ?? []).flatMap((id) => {
      const r = candidates.get(id);
      return r && r.status === "public" && r.kind === "reply" ? [r] : [];
    });
    const reactions = onPublic ? ownerReplies : allReactions.filter((r) => r.itemId === item.id).slice(0, MAX_REACTIONS);
    // A reply that is read as a reaction is not read a second time as a selected letter.
    const reacted = new Set(reactions.map((r) => r.id));
    const read: Letter[] = [];
    for (const id of s.letterIds) {
      if (reacted.has(id)) continue;
      const l = candidates.get(id);
      if (l && l.status === "public" && !hasSource(l)) sourceless++;
      else if (l && l.status === "public") {
        letters.set(l.id, l);
        read.push(l);
      }
    }
    // A segment with nothing left to read does not air: the programme is made of letters and reactions.
    if (read.length === 0 && reactions.length === 0) {
      skippedSegments++;
      continue;
    }
    items.set(item.id, item);
    for (const r of reactions) letters.set(r.id, r);
    plan.push({ ...s, letterIds: read.map((l) => l.id), reactionIds: reactions.map((r) => r.id) });
  }

  if (sourceless > 0) console.warn(`[dococa] skipped ${sourceless} found voice(s) without a source; fix the data`);

  if (skippedSegments > 0) console.warn(`[dococa] skipped ${skippedSegments} segment(s) with nothing to read`);

  const finish = (segments: Episode["segments"]): Episode => {
    const report = verifyEpisode(segments, letters, listener, items, lang);
    const verified = report.verbatim && report.sources && report.topical && report.pii;
    return { id: crypto.randomUUID(), listenerId: listener.id, segments, verified, report, cloudTts: false, station: "mine", lang, createdAt: new Date().toISOString() };
  };

  const readLetters = plan.flatMap((p) => p.letterIds.map((id) => letters.get(id)!));
  const units = readLetters.length > 0 ? await ensureUnits(env, db, readLetters, items, lang) : new Map<string, Unit>();
  // The letter a card or link asked for, when it took the first seat: a first programme then starts right at it.
  const asked = opts.letterId !== undefined && plan[0]?.letterIds[0] === opts.letterId;
  const compose = (u: ReadonlyMap<string, Unit> | null) => finish(composeEpisode(plan, u, letters, items, lang, opts.station?.kind ?? "mine", { first: opts.first ?? true, asked }));

  const usable = (u: ReadonlyMap<string, Unit>) => [...u.values()].some((x) => x.verified);
  if (usable(units)) {
    const whole = compose(units);
    if (whole.verified) return whole;
    console.warn("[dococa] units failed verification in the programme", whole.report.details.join("; "));
    const kept = new Map(units);
    for (const i of segmentsNamed(whole.report.details)) for (const id of plan[i]?.letterIds ?? []) kept.delete(id);
    if (kept.size < units.size && usable(kept)) {
      const fewer = compose(kept);
      if (fewer.verified) return fewer;
    }
  }
  const readings = compose(null);
  if (!readings.verified) throw new EpisodeUnverifiedError(readings.report);
  return readings;
}
