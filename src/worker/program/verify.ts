import type { Item, Letter, Listener, Segment, VerifyReport } from "../types";
import { TOPICAL } from "./topical-words";

/**
 * Counting people, letters or ranks. Digits count with 人/名/通/件/位. Kanji numerals count only when the
 * phrase goes on to say who sent or how many (の方/から/も/が/に/届/ほど/目), so 「二人で」「三人組」
 * 「百人一首」「二人の時間」「世界のどこかの一通を」 stay. 回 counts only as 回再生.
 */
const MEASURE =
  /[0-9]+\s*(?:人|名|通|件|位)|[一二三四五六七八九十百千万]+(?:人|名|通|件)(?=の方|から|も|が|に|届|ほど|目)|何(?:人|名|通|件)も|回再生|第[0-9一二三四五六七八九十]+位|ランキング|一致率|再生回数/u;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
const PHONE = /\d{2,4}-\d{2,4}-\d{3,4}|\d{10,}|\+\d{1,3}[ -]?\d{1,4}[ -]?\d{2,4}[ -]?\d{3,4}/u;
const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(?:co\.jp|com|net|org|jp|io|fm|tv)\b/iu;
/** Ten code points shared with a letter is a quote, not a coincidence. */
const QUOTE_WINDOW = 10;
/** Stands in for a work's title or creator on both sides of the quote check. */
const NAME = "\u{F0000}";

const nonEmpty = (s: string | null) => s !== null && s.trim() !== "";
/** NFKC, invisible format characters (zero-width and the like) removed, whitespace collapsed. */
const norm = (s: string) => s.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function windows(text: string): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i + QUOTE_WINDOW <= cps.length; i++) out.push(cps.slice(i, i + QUOTE_WINDOW).join(""));
  return out;
}

/**
 * Replaces every title and creator with one sentinel code point, in letters and dj lines alike: the DJ
 * may name the work, but a name cannot pad a window, and a copied sentence still matches around it.
 */
function maskNames(items: Map<string, Item>): (text: string) => string {
  const names = [...new Set([...items.values()].flatMap((i) => [norm(i.title).trim(), norm(i.creator).trim()]))]
    .filter((n) => n !== "")
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return (text) => text;
  const re = new RegExp(names.map(escapeRe).join("|"), "gu");
  return (text) => text.replace(re, NAME);
}

/** Masks a data year's digits only, so 「2016年末」 still reads as 年末 and 「12016年」 is untouched. */
function maskDataYears(text: string, years: Set<number>): string {
  let out = text;
  for (const y of years) out = out.replace(new RegExp(`(?<![0-9])${y}(?=年)`, "gu"), "〇");
  return out;
}

/**
 * Deterministic checks on a composed episode; nothing here asks a model. The mechanical guarantee is that
 * every letter is read verbatim from the database and that no dj line shares 10 consecutive code points
 * with any letter; a paraphrase by the DJ is not detectable here and is left to the prompt and the eval.
 * Every dj check runs on normalised text (NFKC, no format characters, collapsed spaces). Lines marked
 * `fixed` come from templates and data, so the word and count checks skip them, but not pii or quotes.
 * A detail reads `{check}: segment {i} line {j}: {term}` and never carries the dj line itself.
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

  const mask = maskNames(items);
  const quotes = new Set<string>();
  for (const l of letters.values()) for (const text of [l.body, l.bodyJa]) for (const w of windows(mask(norm(text)))) quotes.add(w);
  const secrets = [listener.id, listener.mcpToken].map(norm).filter((s) => s !== "");

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
          details.push(`verbatim: ${at}: unknown letter`);
          return;
        }
        if (line.text !== l.bodyJa && line.text !== l.body) {
          verbatim = false;
          details.push(`verbatim: ${at}: differs from letter ${l.id}`);
        }
        if (line.radioName !== l.radioName || line.place !== l.place || line.kind !== l.kind) {
          verbatim = false;
          details.push(`verbatim: ${at}: attribution differs from letter ${l.id}`);
        }
        if ((line.kind === "found" || l.kind === "found") && !(nonEmpty(line.sourceUrl) && nonEmpty(line.sourceAuthor))) {
          sources = false;
          details.push(`sources: ${at}: found voice ${l.id} lacks a url or an author`);
        }
        return;
      }
      if (line.type !== "dj") return;
      const text = norm(line.text);
      if (!line.fixed) {
        const day = maskDataYears(text, years).match(TOPICAL);
        if (day) {
          topical = false;
          details.push(`topical: ${at}: ${day[0]}`);
        }
        const count = text.match(MEASURE);
        if (count) {
          topical = false;
          details.push(`measure: ${at}: ${count[0]}`);
        }
      }
      if (EMAIL.test(text)) {
        pii = false;
        details.push(`pii: ${at}: email address`);
      }
      if (PHONE.test(text)) {
        pii = false;
        details.push(`pii: ${at}: phone number`);
      }
      if (URL_RE.test(text)) {
        pii = false;
        details.push(`pii: ${at}: url`);
      }
      if (secrets.some((s) => text.includes(s))) {
        pii = false;
        details.push(`pii: ${at}: listener account`);
      }
      if (windows(mask(text)).some((w) => quotes.has(w))) {
        pii = false;
        details.push(`pii: ${at}: quotes a letter`);
      }
    });
  });

  return { verbatim, sources, topical, pii, details };
}
