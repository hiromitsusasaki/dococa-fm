import { t } from "../i18n/t";
import type { Lang } from "../i18n/t";
import { siteLabel } from "../letters/label";
import type { Item, Letter, ScriptLine, Segment } from "../types";
import { BRIDGE_KEYS, bridgeBefore, bridgeLine } from "./bridge";
import type { DjLines } from "./script";
import type { Selection } from "./select";

export type SegmentPlan = Selection & { reactionIds: string[] };

/** Reactions read per segment; the rest wait for a later episode. */
export const MAX_REACTIONS = 3;

const dj = (text: string): ScriptLine => ({ type: "dj", text });
/** A line from a template and data, never from the model. */
const fixed = (text: string): ScriptLine => ({ type: "dj", text, fixed: true });

/** Every template a `fixed` line is made from; the quote check reads only what was filled into them. */
export const FIXED_TEMPLATES = ["script.readingOnly", "script.letterFrom", "script.foundVoice", "script.reaction", "script.replyReaction", ...BRIDGE_KEYS] as const;

/** Where a found voice was found, said aloud; the same label the screens show. */
export const siteName = (sourceUrl: string | null): string => siteLabel(sourceUrl) || t("script.web");

/** The letter as stored: the reader reads `bodyJa`, word for word. */
const read = (l: Letter): ScriptLine => ({
  type: "letter",
  letterId: l.id,
  text: l.bodyJa,
  radioName: l.radioName,
  place: l.place,
  kind: l.kind,
  sourceUrl: l.sourceUrl,
  sourceAuthor: l.sourceAuthor,
  ...(l.demo ? { demo: true as const } : {}),
});

function who(l: Letter): string {
  if (l.radioName === "") return t("script.someone");
  const name = t("letter.who", { name: l.radioName });
  return l.place === "" ? name : t("letter.whoPlace", { who: name, place: l.place });
}

function reaction(l: Letter): ScriptLine[] {
  if (l.kind === "reply") return [fixed(t("script.replyReaction", { who: who(l) })), read(l)];
  return [fixed(t("script.reaction", { who: who(l) }))];
}

/**
 * Lays out each segment. Letter lines come from `letters` only, so nothing the DJ wrote can stand in
 * for a letter. With `djLines === null` the DJ says only fixed phrases.
 */
export function composeEpisode(
  plan: SegmentPlan[],
  djLines: DjLines[] | null,
  letters: Map<string, Letter>,
  items: Map<string, Item>,
  lang: Lang = "ja",
): Segment[] {
  if (djLines !== null && djLines.length !== plan.length) throw new Error("dj lines do not match the segments");
  const segments = plan.map((p, i) => {
    const item = items.get(p.itemId);
    if (!item) throw new Error(`item missing: ${p.itemId}`);
    if (p.letterIds.length === 0 && p.reactionIds.length === 0) throw new Error("segment without letters");
    const said = djLines?.[i];
    const lines: ScriptLine[] = [bridgeLine(bridgeBefore(i, p.slot), lang)];
    let readLetters = 0;
    if (said && said.sayBefore !== "") lines.push(dj(said.sayBefore));
    for (const id of p.letterIds) {
      const l = letters.get(id);
      if (!l) continue;
      if (readLetters++ > 0) lines.push(bridgeLine("bridge.sameWork", lang));
      if (!said && l.kind !== "found") {
        lines.push(fixed(l.radioName === "" ? t("script.readingOnly") : t("script.letterFrom", { who: who(l) })));
      }
      if (l.kind === "found") {
        lines.push(fixed(t("script.foundVoice", { author: l.sourceAuthor ?? "", site: siteName(l.sourceUrl) })));
      }
      lines.push(read(l));
    }
    for (const id of p.reactionIds.slice(0, MAX_REACTIONS)) {
      const l = letters.get(id);
      if (l) lines.push(...reaction(l));
    }
    if (said && said.sayAfter !== "") lines.push(dj(said.sayAfter));
    return { itemId: p.itemId, slot: p.slot, lines };
  });
  segments.at(-1)?.lines.push(bridgeLine("bridge.close", lang));
  return segments;
}
