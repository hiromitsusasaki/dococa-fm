import { t } from "../i18n/t";
import type { Item, Letter, Listener, Segment, VerifyReport } from "../types";
import { FIXED_TEMPLATES } from "./compose";
import { ADDRESS, EMAIL, normalizeText as norm, PHONE, POSTAL, URL_RE } from "./pii-patterns";
import { maskDataYears, TOPICAL } from "./topical-words";

/**
 * Counting people, letters or ranks. Digits count with 人/名/通/件/位. Kanji numerals count only when the
 * phrase goes on to say who sent or how many (の方/から/も/が/に/届/ほど/目), so 「二人で」「三人組」
 * 「百人一首」「二人の時間」「世界のどこかの一通を」 stay. 回 counts only as 回再生.
 * Works count too (曲/作品/冊/本/枚/話), from two up: 「静かな一曲」「1本の映画」 name one work, they do not count.
 * Checked after titles and creators are masked, so a title such as 「千本桜」 is not a count.
 */
const MEASURE =
  /[0-9]+\s*(?:人|名|通|件|位)|[一二三四五六七八九十百千万]+(?:人|名|通|件)(?=の方|から|も|が|に|届|ほど|目)|何(?:人|名|通|件|曲|作品|冊|本|枚)も|回再生|第[0-9一二三四五六七八九十]+位|ランキング|一致率|再生回数|(?<![0-9])(?!1\s*(?:曲|作品|冊|本|枚|話))[0-9]+\s*(?:曲|作品|冊|本|枚|話)|(?<![一二三四五六七八九十百千万])(?!一(?:曲|作品|冊|本|枚|話))[一二三四五六七八九十百千万]+(?:曲|作品|冊|本|枚|話)/u;
/** Nothing is played on this radio: the DJ introduces and reads, never invites the listener to listen or watch. */
const PLAYBACK =
  /(?<!語り|問い|呼び|話し|働き|追い|声を|心に|気に|手間を|時間を|鍵を|電話を)かけ(?:ます|ましょう|る|てみ|てください)|(?<!涙を|汗を|水に|聞き)流し(?:ます|ましょう)|お聴きください|聴いて(?:みて)?ください|観てください|お楽しみください|どうぞ(?!よろしく)/u;
/** Ten code points shared with a letter is a quote, not a coincidence. */
const QUOTE_WINDOW = 10;
/** Stands in for a work's title or creator on both sides of the quote check. */
const NAME = "\u{F0000}";

const nonEmpty = (s: string | null) => s !== null && s.trim() !== "";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One anchored pattern per fixed template, its wording normalised like a dj line and each `{param}` a lazy
 * capture. A fixed line is quote-checked on its captures only, joined by the name sentinel, so a letter that
 * happens to contain 「ネットで見つけた声です」 cannot fail the template that says it.
 */
const FIXED_PATTERNS = FIXED_TEMPLATES.map(
  (key) => new RegExp(`^${t(key).split(/\{\w+\}/u).map((part) => escapeRe(norm(part))).join("(.*?)")}$`, "u"),
);

/** What was filled into a fixed line; the whole line when it matches no template. */
function filledValues(text: string): string {
  for (const re of FIXED_PATTERNS) {
    const m = text.match(re);
    if (m) return m.slice(1).join(NAME);
  }
  return text;
}

function windows(text: string): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i + QUOTE_WINDOW <= cps.length; i++) out.push(cps.slice(i, i + QUOTE_WINDOW).join(""));
  return out;
}

/**
 * Lower-cases, then replaces every title and creator with one sentinel code point, in letters and dj
 * lines alike: the DJ may name the work in any case, but a name cannot pad a window, and a copied
 * sentence still matches around it. Used for the quote check only.
 */
function maskNames(items: Map<string, Item>): (text: string) => string {
  const names = [...new Set([...items.values()].flatMap((i) => [norm(i.title).trim().toLowerCase(), norm(i.creator).trim().toLowerCase()]))]
    .filter((n) => n !== "")
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return (text) => text.toLowerCase();
  const re = new RegExp(names.map(escapeRe).join("|"), "gu");
  return (text) => text.toLowerCase().replace(re, NAME);
}

/**
 * Deterministic checks on a composed episode; nothing here asks a model. The mechanical guarantee is that
 * every letter is read verbatim from the database and that no dj line shares 10 consecutive code points
 * with any letter, after work titles and creators collapse to one sentinel each; a paraphrase by the DJ is
 * not detectable here and is left to the prompt and the eval. Every dj check runs on normalised text (NFKC,
 * no format characters, collapsed spaces). Lines marked `fixed` are our templates filled with names, places
 * and sources that are shown on screen anyway, so they get only the account and quote checks, and the quote
 * check sees only the filled-in values, never the template wording.
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

    const hasLetter = seg.lines.some((l) => l.type === "letter");

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
        if (line.radioName !== l.radioName || line.place !== l.place || line.kind !== l.kind || (line.demo === true) !== l.demo) {
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
        // Titles and creators are data, not talk: 「今夜はブギー・バック」 or 「千本桜」 may be named.
        const talk = mask(text);
        const day = maskDataYears(talk, years).match(TOPICAL);
        if (day) {
          topical = false;
          details.push(`topical: ${at}: ${day[0]}`);
        }
        const count = talk.match(MEASURE);
        if (count) {
          topical = false;
          details.push(`measure: ${at}: ${count[0]}`);
        }
      }
      const play = !line.fixed ? mask(text).match(PLAYBACK) : null;
      if (play) {
        topical = false;
        details.push(`playback: ${at}: ${play[0]}`);
      }
      // A letterless segment must not hand over to a reader who has nothing to read.
      if (!line.fixed && !hasLetter && /お便り|読み上げ/u.test(text)) {
        topical = false;
        details.push(`announce: ${at}: announces a letter in a segment with none`);
      }
      if (!line.fixed && EMAIL.test(text)) {
        pii = false;
        details.push(`pii: ${at}: email address`);
      }
      if (!line.fixed && PHONE.test(text)) {
        pii = false;
        details.push(`pii: ${at}: phone number`);
      }
      if (!line.fixed && URL_RE.test(text)) {
        pii = false;
        details.push(`pii: ${at}: url`);
      }
      if (!line.fixed && POSTAL.test(text)) {
        pii = false;
        details.push(`pii: ${at}: postal code`);
      }
      if (!line.fixed && ADDRESS.test(text)) {
        pii = false;
        details.push(`pii: ${at}: street address`);
      }
      if (secrets.some((s) => text.includes(s))) {
        pii = false;
        details.push(`pii: ${at}: listener account`);
      }
      if (windows(mask(line.fixed ? filledValues(text) : text)).some((w) => quotes.has(w))) {
        pii = false;
        details.push(`pii: ${at}: quotes a letter`);
      }
    });
  });

  return { verbatim, sources, topical, pii, details };
}
