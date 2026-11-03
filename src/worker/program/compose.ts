import { t } from "../i18n/t";
import type { Item, Letter, ScriptLine, Segment } from "../types";
import type { DjLines } from "./script";
import type { Selection } from "./select";

export type SegmentPlan = Selection & { reactionIds: string[] };

const MAX_REACTIONS = 3;

const dj = (text: string): ScriptLine => ({ type: "dj", text });

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
});

function who(l: Letter): string {
  if (l.radioName === "") return t("script.someone");
  const name = t("letter.who", { name: l.radioName });
  return l.place === "" ? name : t("letter.whoPlace", { who: name, place: l.place });
}

function reaction(l: Letter): ScriptLine[] {
  if (l.kind === "reply") return [dj(t("script.replyReaction", { who: who(l) })), read(l)];
  return [dj(t("script.reaction", { who: who(l) }))];
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
): Segment[] {
  if (djLines !== null && djLines.length !== plan.length) throw new Error("dj lines do not match the segments");
  return plan.map((p, i) => {
    const item = items.get(p.itemId);
    if (!item) throw new Error(`item missing: ${p.itemId}`);
    const said = djLines?.[i];
    const lines: ScriptLine[] = [];
    if (!said) lines.push(dj(t("script.readingOnly")));
    else if (said.sayBefore !== "") lines.push(dj(said.sayBefore));
    for (const id of p.letterIds) {
      const l = letters.get(id);
      if (!l) continue;
      if (l.kind === "found") lines.push(dj(t("script.foundVoicePrefix")));
      lines.push(read(l));
    }
    if (item.previewUrl) lines.push({ type: "preview", url: item.previewUrl, seconds: 30 });
    for (const id of p.reactionIds.slice(0, MAX_REACTIONS)) {
      const l = letters.get(id);
      if (l) lines.push(...reaction(l));
    }
    if (said && said.sayAfter !== "") lines.push(dj(said.sayAfter));
    return { itemId: p.itemId, slot: p.slot, lines };
  });
}
