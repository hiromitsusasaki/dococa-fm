import { t } from "../i18n/t";
import type { Lang } from "../i18n/t";
import { siteLabel } from "../letters/label";
import type { Item, Letter, ScriptLine, Segment, Unit } from "../types";
import { BRIDGE_KEYS, bridgeBefore, bridgeLine } from "./bridge";
import type { Selection } from "./select";

export type SegmentPlan = Selection & { reactionIds: string[] };

/** Reactions read per segment; the rest wait for a later episode. */
export const MAX_REACTIONS = 3;

/** A line the model wrote for this letter's unit. */
const unitLine = (text: string, letterId: string, part: "intro" | "after"): ScriptLine => ({ type: "dj", text, unit: { letterId, part } });
/** A line from a template and data, never from the model. */
const fixed = (text: string): ScriptLine => ({ type: "dj", text, fixed: true });

/** Every template a `fixed` line is made from; the quote check reads only what was filled into them. */
export const FIXED_TEMPLATES = ["script.readingOnly", "script.letterFrom", "script.foundVoice", "script.reaction", "script.replyReaction", ...BRIDGE_KEYS] as const;

/** Where a found voice was found, said aloud; the same label the screens show. */
export const siteName = (sourceUrl: string | null): string => siteLabel(sourceUrl) || t("script.web");

/** The letter as stored: the reader reads `bodyJa`, word for word. */
export const read = (l: Letter): ScriptLine => ({
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

/** The fixed line that hands over to the letter's reader: the sender, or the found voice's author and site. */
export function handOver(l: Letter): ScriptLine {
  if (l.kind === "found") return fixed(t("script.foundVoice", { author: l.sourceAuthor ?? "", site: siteName(l.sourceUrl) }));
  return fixed(l.radioName === "" ? t("script.readingOnly") : t("script.letterFrom", { who: who(l) }));
}

/** The DJ's two lines for one letter, as a unit carries them. */
export type UnitLines = Pick<Unit, "intro" | "after">;

/**
 * One letter as it airs: the unit's intro (when asked for), the fixed hand-over, the letter verbatim, the
 * unit's after. With no unit the DJ says the hand-over only.
 */
export function letterLines(l: Letter, unit: UnitLines | null, withIntro: boolean): ScriptLine[] {
  const lines: ScriptLine[] = [];
  if (unit && withIntro && unit.intro !== "") lines.push(unitLine(unit.intro, l.id, "intro"));
  lines.push(handOver(l), read(l));
  if (unit && unit.after !== "") lines.push(unitLine(unit.after, l.id, "after"));
  return lines;
}

/**
 * Lays out each segment: bridge, the work's intro, then per letter [hand-over, letter, after] with a sameWork
 * bridge between letters, then the reactions; the close bridge ends the episode. The intro is the unit of the
 * first letter that has one (a reply read as a letter has no unit), said once before the first hand-over.
 * Letter lines come from `letters` only, so nothing the DJ wrote can stand in for a letter. Only verified
 * units speak; with `units === null`, or no verified unit for a letter, the DJ says only fixed phrases around it.
 */
export function composeEpisode(
  plan: SegmentPlan[],
  units: ReadonlyMap<string, Unit> | null,
  letters: ReadonlyMap<string, Letter>,
  items: ReadonlyMap<string, Item>,
  lang: Lang = "ja",
): Segment[] {
  const spoken = (l: Letter): Unit | null => {
    const u = units?.get(l.id);
    return u?.verified ? u : null;
  };
  const segments = plan.map((p, i) => {
    const item = items.get(p.itemId);
    if (!item) throw new Error(`item missing: ${p.itemId}`);
    if (p.letterIds.length === 0 && p.reactionIds.length === 0) throw new Error("segment without letters");
    const present = p.letterIds.flatMap((id) => letters.get(id) ?? []);
    const lines: ScriptLine[] = [bridgeLine(bridgeBefore(i, p.slot), lang)];
    const introBy = present.find((l) => (spoken(l)?.intro ?? "") !== "");
    if (introBy) lines.push(unitLine(spoken(introBy)!.intro, introBy.id, "intro"));
    present.forEach((l, n) => {
      if (n > 0) lines.push(bridgeLine("bridge.sameWork", lang));
      lines.push(...letterLines(l, spoken(l), false));
    });
    for (const id of p.reactionIds.slice(0, MAX_REACTIONS)) {
      const l = letters.get(id);
      if (l) lines.push(...reaction(l));
    }
    return { itemId: p.itemId, slot: p.slot, lines };
  });
  segments.at(-1)?.lines.push(bridgeLine("bridge.close", lang));
  return segments;
}
