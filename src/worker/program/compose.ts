import { placeLabel } from "../geo/place-label";
import { t } from "../i18n/t";
import type { Lang } from "../i18n/t";
import { siteLabel } from "../letters/label";
import type { Item, Letter, Reading, ScriptLine, Segment, Unit } from "../types";
import { BRIDGE_KEYS, bridgeBefore, bridgeLine } from "./bridge";
import type { Selection } from "./select";
import type { StationKey } from "./station";

export type SegmentPlan = Selection & { reactionIds: string[] };

/** Reactions read per segment; the rest wait for a later episode. */
export const MAX_REACTIONS = 3;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text as the voice says it: every reading's `text` replaced by its `reading`, exact strings, the longest
 * first, in one pass (a reading is never itself replaced again). The text itself when there is nothing to replace.
 */
export function applyReadings(text: string, readings: readonly Reading[]): string {
  const byText = new Map(readings.filter((r) => r.text !== "").map((r) => [r.text, r.reading]));
  if (byText.size === 0) return text;
  const re = new RegExp([...byText.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "gu");
  return text.replace(re, (m) => byText.get(m) ?? m);
}

/** The work's own readings as `Reading`s: its title and creator as written, and as the voice says them. */
export function itemReadings(item: Item): Reading[] {
  const r = item.readingJa;
  return [
    ...(r?.title && item.title !== "" ? [{ text: item.title, reading: r.title }] : []),
    ...(r?.creator && item.creator.trim() !== "" ? [{ text: item.creator.trim(), reading: r.creator }] : []),
  ];
}

/**
 * The readings a unit's lines are voiced with in `lang`: the unit's own, then the work's, which win for its title
 * and creator so every programme says the work alike. English has none: the voice reads English as written.
 */
export function speechReadings(unit: Pick<Unit, "readings"> | null, item: Item, lang: Lang): Reading[] {
  if (lang !== "ja") return [];
  const byText = new Map<string, string>();
  for (const r of [...(unit?.readings ?? []), ...itemReadings(item)]) byText.set(r.text, r.reading);
  return [...byText].map(([text, reading]) => ({ text, reading }));
}

/** A line the model wrote for this letter's unit, with `spoken` when a reading changes what the voice says. */
function unitLine(text: string, letterId: string, part: "intro" | "after", readings: readonly Reading[] = []): ScriptLine {
  const spoken = applyReadings(text, readings);
  return { type: "dj", text, ...(spoken !== text ? { spoken } : {}), unit: { letterId, part } };
}
/** A line from a template and data, never from the model. */
const fixed = (text: string): ScriptLine => ({ type: "dj", text, fixed: true });

/** Every template a `fixed` line is made from; the quote check reads only what was filled into them. */
export const FIXED_TEMPLATES = [
  "script.readingOnly",
  "script.letterFrom",
  "script.foundVoice",
  "script.reaction",
  "script.replyReaction",
  ...(["music", "book", "film", "video"] as const).flatMap((k) => [`script.lead.${k}`, `script.lead.${k}.noCreator`] as const),
  ...BRIDGE_KEYS,
] as const;

/**
 * The fixed line that names the work by its kind before the DJ talks about it: its own title and creator, never the
 * model's words. In Japanese, `spoken` fills the same template with the work's readings, when it has any.
 */
export function leadLine(item: Item, lang: Lang = "ja"): Extract<ScriptLine, { type: "dj" }> {
  const creator = item.creator.trim();
  const fill = (title: string, by: string) => (creator === "" ? t(`script.lead.${item.kind}.noCreator`, { title }, lang) : t(`script.lead.${item.kind}`, { title, creator: by }, lang));
  const text = fill(item.title, creator);
  const r = lang === "ja" ? item.readingJa : undefined;
  const spoken = r ? fill(r.title || item.title, r.creator || creator) : text;
  return { type: "dj", text, ...(spoken !== text ? { spoken } : {}), fixed: true };
}

/** Where a found voice was found, said aloud; the same label the screens show. */
export const siteName = (sourceUrl: string | null, lang: Lang = "ja"): string => siteLabel(sourceUrl) || t("script.web", undefined, lang);

/** The place the DJ says: the Japanese label, or in English the label made from the codes when the letter has them. */
export const placeSaid = (l: Letter, lang: Lang): string => (lang === "en" && l.placeCountry ? placeLabel(l.placeCountry, l.placeRegion, "en") || l.place : l.place);

/** The letter as stored: the reader reads `bodyJa`, or in English `bodyEn` (the original when there is none), word for word. */
export const read = (l: Letter, lang: Lang = "ja"): ScriptLine => ({
  type: "letter",
  letterId: l.id,
  text: lang === "en" ? (l.bodyEn ?? l.body) : l.bodyJa,
  radioName: l.radioName,
  place: l.place,
  ...(l.placeCountry ? { placeCountry: l.placeCountry } : {}),
  ...(l.placeRegion ? { placeRegion: l.placeRegion } : {}),
  kind: l.kind,
  sourceUrl: l.sourceUrl,
  sourceAuthor: l.sourceAuthor,
  ...(l.demo ? { demo: true as const } : {}),
});

function who(l: Letter, lang: Lang): string {
  if (l.radioName === "") return t("script.someone", undefined, lang);
  const name = t("letter.who", { name: l.radioName }, lang);
  const place = placeSaid(l, lang);
  return place === "" ? name : t("script.whoPlace", { who: name, place }, lang);
}

function reaction(l: Letter, lang: Lang): ScriptLine[] {
  if (l.kind === "reply") return [fixed(t("script.replyReaction", { who: who(l, lang) }, lang)), read(l, lang)];
  return [fixed(t("script.reaction", { who: who(l, lang) }, lang))];
}

/**
 * The fixed line that hands over to the letter's reader: the sender, or the found voice's author and site. With
 * `readings` (the unit's, in Japanese), `spoken` says the sender's place and radio name as read (大船渡 → オオフナト).
 */
export function handOver(l: Letter, lang: Lang = "ja", readings: readonly Reading[] = []): ScriptLine {
  const text =
    l.kind === "found"
      ? t("script.foundVoice", { author: l.sourceAuthor ?? "", site: siteName(l.sourceUrl, lang) }, lang)
      : l.radioName === ""
        ? t("script.readingOnly", undefined, lang)
        : t("script.letterFrom", { who: who(l, lang) }, lang);
  const spoken = applyReadings(text, readings);
  return { type: "dj", text, ...(spoken !== text ? { spoken } : {}), fixed: true };
}

/** The DJ's two lines for one letter, and the readings they are voiced with, as a unit carries them. */
export type UnitLines = Pick<Unit, "intro" | "after" | "readings">;

/**
 * One letter as it airs: the unit's intro (when asked for), the fixed hand-over, the letter verbatim, the
 * unit's after. With no unit the DJ says the hand-over only. `readings` (see `speechReadings`) voice the unit's lines and
 * the hand-over; the letter is always voiced as written.
 */
export function letterLines(l: Letter, unit: UnitLines | null, withIntro: boolean, lang: Lang = "ja", readings: readonly Reading[] = []): ScriptLine[] {
  const lines: ScriptLine[] = [];
  if (unit && withIntro && unit.intro !== "") lines.push(unitLine(unit.intro, l.id, "intro", readings));
  lines.push(handOver(l, lang, readings), read(l, lang));
  if (unit && unit.after !== "") lines.push(unitLine(unit.after, l.id, "after", readings));
  return lines;
}

/**
 * Lays out each segment: bridge, the fixed lead naming the work, the work's intro, then per letter [hand-over, letter, after] with a sameWork
 * bridge between letters, then the reactions; nothing closes the episode. The intro is the first
 * letter's own verified unit, said once before its hand-over; with none (a reply read first has no unit), none.
 * Letter lines come from `letters` only, so nothing the DJ wrote can stand in for a letter. Only verified
 * units speak; with `units === null`, or no verified unit for a letter, the DJ says only fixed phrases around it.
 */
export function composeEpisode(
  plan: SegmentPlan[],
  units: ReadonlyMap<string, Unit> | null,
  letters: ReadonlyMap<string, Letter>,
  items: ReadonlyMap<string, Item>,
  lang: Lang = "ja",
  /** The station the programme airs on: a public one bridges with neutral lines. */
  station: StationKey["kind"] = "mine",
  /**
   * `first`: the first programme the listener hears on this visit: only then the DJ opens. `asked`: its first segment
   * leads with the letter the listener asked for, so a first programme starts at that letter, with no opening or bridge.
   */
  { first: opens = true, asked = false }: { first?: boolean; asked?: boolean } = {},
): Segment[] {
  const spoken = (l: Letter): Unit | null => {
    const u = units?.get(l.id);
    return u?.verified ? u : null;
  };
  return plan.map((p, i) => {
    const item = items.get(p.itemId);
    if (!item) throw new Error(`item missing: ${p.itemId}`);
    if (p.letterIds.length === 0 && p.reactionIds.length === 0) throw new Error("segment without letters");
    const present = p.letterIds.flatMap((id) => letters.get(id) ?? []);
    const lines: ScriptLine[] = opens && asked && i === 0 ? [] : [bridgeLine(bridgeBefore(opens && i === 0, p.slot, station), lang)];
    // A unit's intro was written with its own letter in the prompt, so it airs only before that letter.
    // The lead names the work once, before the first letter, with or without a unit.
    const first = present[0];
    if (first) lines.push(leadLine(item, lang));
    const firstUnit = first ? spoken(first) : null;
    const intro = firstUnit?.intro ?? "";
    if (first && intro !== "") lines.push(unitLine(intro, first.id, "intro", speechReadings(firstUnit, item, lang)));
    present.forEach((l, n) => {
      if (n > 0) lines.push(bridgeLine("bridge.sameWork", lang));
      const u = spoken(l);
      lines.push(...letterLines(l, u, false, lang, speechReadings(u, item, lang)));
    });
    for (const id of p.reactionIds.slice(0, MAX_REACTIONS)) {
      const l = letters.get(id);
      if (l) lines.push(...reaction(l, lang));
    }
    return { itemId: p.itemId, slot: p.slot, lines };
  });
}
