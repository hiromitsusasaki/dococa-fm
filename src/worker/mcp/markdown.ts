import { isHttpUrl, whoOf } from "../../views/components";
import { oneLine } from "../claude/client";
import { ja } from "../i18n/ja";
import { type Lang, tFor } from "../i18n/t";
import { displayText } from "../letters/display";
import type { Episode, Item, Letter, ScriptLine } from "../types";

type LetterLine = Extract<ScriptLine, { type: "letter" }>;

export type EpisodeData = {
  items: ReadonlyMap<string, Item>;
  /** Stored letters by id, used to put the untouched original beside a translation. */
  letters: ReadonlyMap<string, Letter>;
};

/** Full-width parentheses for Japanese, ASCII with a leading space for English. */
const paren = (s: string, lang: Lang): string => (lang === "ja" ? `（${s}）` : ` (${s})`);

/** One line of heading text: a title cannot break out of its heading or open a new one. */
const headingText = (s: string): string => oneLine(s).replace(/^[\s#]+/, "");

/** A blockquote that keeps every character and line break of `text`. */
const quote = (text: string): string => text.split("\n").map((l) => `> ${l}`).join("\n");

function sourceLine(author: string | null, url: string | null, lang: Lang): string {
  const t = tFor(lang);
  const name = author ?? "";
  return `${t("item.source")}: ${isHttpUrl(url) ? `[${name}](${url})` : name}`.trimEnd();
}

/** The letter as it is read out, then who sent it (or where it was found). */
function letterBlock(text: string, original: string | null, who: Parameters<typeof whoOf>[0] & { kind: Letter["kind"]; sourceAuthor: string | null; sourceUrl: string | null }, lang: Lang): string {
  const body = original !== null && original !== text ? `${quote(text)}\n${quote(original)}` : quote(text);
  const credit = who.kind === "found" ? sourceLine(who.sourceAuthor, who.sourceUrl, lang) : `— ${whoOf(who, lang)}`;
  return `${body}\n\n${credit}`;
}

export const renderLetter = (l: Letter, lang: Lang): string => {
  const { main, original } = displayText(l, lang);
  return letterBlock(main, original, l, lang);
};

function renderLine(line: ScriptLine, data: EpisodeData, lang: Lang): string {
  if (line.type === "dj") return line.text;
  if (line.type === "preview") return isHttpUrl(line.url) ? `[${tFor(lang)("mcp.preview")}](${line.url})` : "";
  const stored = data.letters.get((line as LetterLine).letterId);
  const shown = stored ? displayText(stored, lang) : { main: line.text, original: null };
  return letterBlock(shown.main, shown.original, { ...line, demo: stored?.demo ?? line.demo === true }, lang);
}

/** What the assistant reads to the listener: the instruction, then each segment in order. No counts, no numbering. */
export function renderEpisode(episode: Episode, data: EpisodeData, lang: Lang): string {
  const t = tFor(lang);
  const parts = [t("mcp.instruction")];
  for (const seg of episode.segments) {
    const item = data.items.get(seg.itemId);
    if (!item) continue;
    parts.push(`## ${headingText(item.title)} / ${headingText(item.creator)}${paren(t(`slot.${seg.slot}`), lang)}\n<!-- itemId: ${item.id} -->`);
    parts.push(...seg.lines.map((l) => renderLine(l, data, lang)).filter((s) => s !== ""));
  }
  return parts.join("\n\n");
}

const outLabel = (key: string, lang: Lang): string | null => (`out.${key}` in ja ? tFor(lang)(`out.${key}` as keyof typeof ja) : null);

export function renderItemCard(item: Item, lang: Lang): string {
  const t = tFor(lang);
  const head = `## ${headingText(item.title)}\n${t(`kind.${item.kind}`)} / ${headingText(item.creator)}${item.year !== null ? paren(String(item.year), lang) : ""}\n<!-- itemId: ${item.id} -->`;
  const links = Object.entries(item.outLinks).flatMap(([key, href]) => {
    const label = outLabel(key, lang);
    return label && isHttpUrl(href) ? [`- [${label}](${href})`] : [];
  });
  return links.length > 0 ? `${head}\n\n${links.join("\n")}` : head;
}

/** A reaction as one quoted line under its parent, so the assistant sees who answered what. */
const renderReaction = (r: Letter, lang: Lang): string =>
  r.kind === "watashimo" ? `> ${tFor(lang)("reaction.from", { who: whoOf(r, lang), body: displayText(r, lang).main })}` : `${quote(displayText(r, lang).main)}\n> — ${whoOf(r, lang)}`;

/** The item card and its public top-level letters; reactions sit under their parent, and only a top-level letter carries an id for `react`. */
export function renderItemPage(item: Item, letters: Letter[], lang: Lang): string {
  const t = tFor(lang);
  const top = letters.filter((l) => l.parentLetterId === null);
  const block = (l: Letter) => {
    const reactions = letters.filter((r) => r.parentLetterId === l.id).map((r) => renderReaction(r, lang));
    return [renderLetter(l, lang), ...reactions, `<!-- letterId: ${l.id} -->`].join("\n\n");
  };
  const body = top.length === 0 ? t("mcp.nothing") : top.map(block).join("\n\n");
  return `${renderItemCard(item, lang)}\n\n### ${t("item.letters")}\n\n${body}`;
}
