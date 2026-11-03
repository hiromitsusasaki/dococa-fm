import { isHttpUrl, whoOf } from "../../views/components";
import { ja } from "../i18n/ja";
import { t } from "../i18n/t";
import type { Episode, Item, Letter, ScriptLine } from "../types";

type LetterLine = Extract<ScriptLine, { type: "letter" }>;

export type EpisodeData = {
  items: ReadonlyMap<string, Item>;
  /** Stored letters by id, used to put the untouched original beside a translation. */
  letters: ReadonlyMap<string, Letter>;
};

/** A blockquote that keeps every character and line break of `text`. */
const quote = (text: string): string => text.split("\n").map((l) => `> ${l}`).join("\n");

function sourceLine(author: string | null, url: string | null): string {
  const name = author ?? "";
  return `${t("item.source")}: ${isHttpUrl(url) ? `[${name}](${url})` : name}`.trimEnd();
}

/** The letter as it is read out, then who sent it (or where it was found). */
function letterBlock(text: string, original: string | null, who: Parameters<typeof whoOf>[0] & { kind: Letter["kind"]; sourceAuthor: string | null; sourceUrl: string | null }): string {
  const body = original !== null && original !== text ? `${quote(text)}\n${quote(original)}` : quote(text);
  const credit = who.kind === "found" ? sourceLine(who.sourceAuthor, who.sourceUrl) : `— ${whoOf(who)}`;
  return `${body}\n\n${credit}`;
}

export const renderLetter = (l: Letter): string => letterBlock(l.bodyJa, l.lang !== "ja" ? l.body : null, l);

function renderLine(line: ScriptLine, data: EpisodeData): string {
  if (line.type === "dj") return line.text;
  if (line.type === "preview") return isHttpUrl(line.url) ? `[${t("mcp.preview")}](${line.url})` : "";
  const stored = data.letters.get((line as LetterLine).letterId);
  return letterBlock(line.text, stored && stored.lang !== "ja" ? stored.body : null, { ...line, demo: stored?.demo ?? line.demo === true });
}

/** What the assistant reads to the listener: the instruction, then each segment in order. No counts, no numbering. */
export function renderEpisode(episode: Episode, data: EpisodeData): string {
  const parts = [t("mcp.instruction")];
  for (const seg of episode.segments) {
    const item = data.items.get(seg.itemId);
    if (!item) continue;
    parts.push(`## ${item.title} / ${item.creator}（${t(`slot.${seg.slot}`)}）\n<!-- itemId: ${item.id} -->`);
    parts.push(...seg.lines.map((l) => renderLine(l, data)).filter((s) => s !== ""));
  }
  return parts.join("\n\n");
}

const outLabel = (key: string): string | null => (`out.${key}` in ja ? t(`out.${key}` as keyof typeof ja) : null);

export function renderItemCard(item: Item): string {
  const head = `## ${item.title}\n${t(`kind.${item.kind}`)} / ${item.creator}${item.year !== null ? `（${item.year}）` : ""}\n<!-- itemId: ${item.id} -->`;
  const links = Object.entries(item.outLinks).flatMap(([key, href]) => {
    const label = outLabel(key);
    return label && isHttpUrl(href) ? [`- [${label}](${href})`] : [];
  });
  return links.length > 0 ? `${head}\n\n${links.join("\n")}` : head;
}

/** A reaction as one quoted line under its parent, so the assistant sees who answered what. */
const renderReaction = (r: Letter): string =>
  r.kind === "watashimo" ? `> ${t("reaction.from", { who: whoOf(r), body: r.bodyJa })}` : `${quote(r.bodyJa)}\n> — ${whoOf(r)}`;

/** The item card and its public top-level letters; reactions sit under their parent, and only a top-level letter carries an id for `react`. */
export function renderItemPage(item: Item, letters: Letter[]): string {
  const top = letters.filter((l) => l.parentLetterId === null);
  const block = (l: Letter) => {
    const reactions = letters.filter((r) => r.parentLetterId === l.id).map(renderReaction);
    return [renderLetter(l), ...reactions, `<!-- letterId: ${l.id} -->`].join("\n\n");
  };
  const body = top.length === 0 ? t("mcp.nothing") : top.map(block).join("\n\n");
  return `${renderItemCard(item)}\n\n### ${t("item.letters")}\n\n${body}`;
}
