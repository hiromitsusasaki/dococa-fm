import type { Item, Letter, Listener, Segment, VerifyReport } from "../types";
import { TOPICAL } from "./topical-words";

/**
 * Counting people, letters or ranks. Kanji numerals count only with 通/件/位, so 「二人で」「三人組」
 * 「百人一首」 stay; a lone 「一通」 stays too, as the program's name for a letter.
 */
const MEASURE =
  /[0-9]+\s*(?:件|通|人|位|回)|(?:[二三四五六七八九十百千万]|一[一二三四五六七八九十百千万])[一二三四五六七八九十百千万]*(?:通|件|位)|一(?:通目|件目|位)|第[0-9一二三四五六七八九十]+位|ランキング|一致率|再生回数/u;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
const PHONE = /\d{2,4}-\d{2,4}-\d{3,4}|\d{10,}/u;
const URL_RE = /https?:\/\//iu;
/** Ten code points shared with a letter is a quote, not a coincidence. */
const QUOTE_WINDOW = 10;

const nonEmpty = (s: string | null) => s !== null && s.trim() !== "";
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/gu, " ");

function windows(text: string): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i + QUOTE_WINDOW <= cps.length; i++) out.push(cps.slice(i, i + QUOTE_WINDOW).join(""));
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Splits text at every work title and creator, so no quote window spans a name the DJ may say. Names
 * shorter than 4 code points rarely build a 10-code-point overlap and would cut letters too finely.
 */
function splitAtNames(items: Map<string, Item>): (text: string) => string[] {
  const names = [...new Set([...items.values()].flatMap((i) => [norm(i.title).trim(), norm(i.creator).trim()]))]
    .filter((n) => Array.from(n).length >= 4)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return (text) => [text];
  const re = new RegExp(names.map(escapeRe).join("|"), "gu");
  return (text) => text.split(re);
}

/** Every 10-code-point stretch of every letter, original and translation. */
function quoteIndex(letters: Map<string, Letter>, split: (text: string) => string[]): Set<string> {
  const index = new Set<string>();
  for (const l of letters.values()) {
    for (const text of [l.body, l.bodyJa]) for (const part of split(norm(text))) for (const w of windows(part)) index.add(w);
  }
  return index;
}

/** Years taken from the data (the work's, a letter's) are not 時事; any other year is. */
function withoutDataYears(text: string, years: Set<number>): string {
  let out = text;
  for (const y of years) out = out.split(`${y}年`).join("〇");
  return out;
}

/**
 * Deterministic checks on a composed episode; nothing here asks a model. Every dj check runs on
 * NFKC-normalised text so full-width digits and letters cannot slip past. A detail names the check, where
 * it failed and, for word checks, the dj line, so a retry can be told what to rephrase. Lines that leak
 * the account or quote a letter are not repeated in the detail.
 */
export function verifyEpisode(
  segments: Segment[],
  letters: Map<string, Letter>,
  listener: Listener,
  items: Map<string, Item> = new Map(),
): VerifyReport {
  const details: string[] = [];
  let verbatim = true;
  let sources = true;
  let topical = true;
  let pii = true;

  const split = splitAtNames(items);
  const quotes = quoteIndex(letters, split);
  const secrets = [listener.id, listener.mcpToken].filter((s) => s !== "").map(norm);

  segments.forEach((seg, si) => {
    const years = new Set<number>();
    const itemYear = items.get(seg.itemId)?.year;
    if (itemYear != null) years.add(itemYear);
    for (const line of seg.lines) {
      const y = line.type === "letter" ? letters.get(line.letterId)?.year : null;
      if (y != null) years.add(y);
    }

    seg.lines.forEach((line, li) => {
      const at = `segment ${si + 1} line ${li + 1}`;
      if (line.type === "letter") {
        const l = letters.get(line.letterId);
        if (!l) {
          verbatim = false;
          details.push(`verbatim: ${at} reads an unknown letter`);
          return;
        }
        if (line.text !== l.bodyJa && line.text !== l.body) {
          verbatim = false;
          details.push(`verbatim: ${at} differs from letter ${l.id}`);
        }
        if (line.radioName !== l.radioName || line.place !== l.place || line.kind !== l.kind) {
          verbatim = false;
          details.push(`verbatim: ${at} credits letter ${l.id} to someone else`);
        }
        if ((line.kind === "found" || l.kind === "found") && !(nonEmpty(line.sourceUrl) && nonEmpty(line.sourceAuthor))) {
          sources = false;
          details.push(`sources: ${at} found voice ${l.id} lacks a url or an author`);
        }
        return;
      }
      if (line.type !== "dj") return;
      const text = norm(line.text);
      const day = withoutDataYears(text, years).match(TOPICAL);
      if (day) {
        topical = false;
        details.push(`topical: ${at} 「${day[0]}」 in 「${line.text}」`);
      }
      const count = text.match(MEASURE);
      if (count) {
        topical = false;
        details.push(`measure: ${at} 「${count[0]}」 in 「${line.text}」`);
      }
      if (EMAIL.test(text) || PHONE.test(text) || URL_RE.test(text)) {
        pii = false;
        details.push(`pii: ${at} has an address, a phone number or a url`);
      }
      if (secrets.some((s) => text.includes(s))) {
        pii = false;
        details.push(`pii: ${at} names the listener's account`);
      }
      if (split(text).some((part) => windows(part).some((w) => quotes.has(w)))) {
        pii = false;
        details.push(`pii: ${at} quotes a letter`);
      }
    });
  });

  return { verbatim, sources, topical, pii, details };
}
