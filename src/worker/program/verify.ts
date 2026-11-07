import { isCountryName, regionLabels } from "../geo/place-label";
import { t, type Lang } from "../i18n/t";
import type { Item, Letter, Listener, Segment, VerifyReport } from "../types";
import { applyReadings, FIXED_TEMPLATES, itemReadings } from "./compose";
import { ADDRESS, EMAIL, normalizeText as norm, PHONE, POSTAL, URL_RE } from "./pii-patterns";
import { maskDataYears, TOPICAL } from "./topical-words";
import { ANNOUNCE_EN, maskDataYearsEn, MEASURE_EN, PLAYBACK_EN, TOPICAL_EN, YEAR_EN } from "./verify-en";

/**
 * Counting people, letters or ranks. Digits count with 人/名/通/件/位. Kanji numerals count only when the
 * phrase goes on to say who sent or how many (の方/から/も/が/に/届/ほど/目), so 「二人で」「三人組」
 * 「百人一首」「二人の時間」「世界のどこかの一通を」 stay. 回 counts only as 回再生.
 * Works count too (曲/作品/冊/本/枚/話), from two up: 「静かな一曲」「1本の映画」 name one work, they do not count.
 * Letters count from two with の after them: 「二通のお便り」 counts, 「一通の」 does not.
 * Checked after titles and creators are masked, so a title such as 「千本桜」 is not a count.
 */
const MEASURE =
  /[二三四五六七八九十百千万]+通(?=の)|[0-9]+\s*(?:人|名|通|件|位)|[一二三四五六七八九十百千万]+(?:人|名|通|件)(?=の方|から|も|が|に|届|ほど|目)|何(?:人|名|通|件|曲|作品|冊|本|枚)も|回再生|第[0-9一二三四五六七八九十]+位|ランキング|一致率|再生回数|(?<![0-9])(?!1\s*(?:曲|作品|冊|本|枚|話))[0-9]+\s*(?:曲|作品|冊|本|枚|話)|(?<![一二三四五六七八九十百千万])(?!一(?:曲|作品|冊|本|枚|話))[一二三四五六七八九十百千万]+(?:曲|作品|冊|本|枚|話)/u;
/** Nothing is played on this radio: the DJ introduces and reads, never invites the listener to listen or watch. */
const PLAYBACK =
  /(?<!語り|問い|呼び|話し|働き|追い|声を|心に|気に|手間を|時間を|鍵を|電話を|見|出|仕|押し|腰|(?:迷惑|心配|手間|電話|時間)をお)かけ(?:ます|ましょう|します|しましょう|る|てみ|てください)|(?<!涙を|汗を|水に|聞き)流し(?:て(?:み)?)?(?:ます|ましょう)|再生(?:します|しましょう|してみ|してください)|お聴きください|お聞きください|聴いて(?:みて)?ください|観て(?:みて)?ください|お楽しみください|どうぞ(?!よろしく)|(?:聴き|聞き|観|見)ましょう|(?:聴いて|聞いて|観て|見て)(?:みて)?(?:ね|ほしい|みましょう)/u;
/** Ten code points shared with a letter is a quote, not a coincidence. */
const QUOTE_WINDOW = 10;
/** English shares short phrases by chance ("of the song"), so an English line quotes only with six words in a row. */
const QUOTE_WORDS_EN = 6;
/** Stands in for a work's title or creator on both sides of the quote check. */
const NAME = "\u{F0000}";

const nonEmpty = (s: string | null) => s !== null && s.trim() !== "";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One anchored pattern for a template: its wording normalised like a dj line and each `{param}` a lazy capture. */
const templatePattern = (key: Parameters<typeof t>[0], lang: Lang) =>
  new RegExp(`^${t(key, undefined, lang).split(/\{\w+\}/u).map((part) => escapeRe(norm(part))).join("(.*?)")}$`, "u");
/**
 * A fixed line is quote-checked on its captures only, joined by the name sentinel, so a letter that happens to
 * contain 「ネットで見つけた声です」 cannot fail the template that says it.
 */
const FIXED_PATTERNS: Record<Lang, RegExp[]> = {
  ja: FIXED_TEMPLATES.map((key) => templatePattern(key, "ja")),
  en: FIXED_TEMPLATES.map((key) => templatePattern(key, "en")),
};
/** Every capture is re-split through the nested sender phrase (`script.whoPlace`), so its own wording is not a quote either. */
const WHO_PLACE: Record<Lang, RegExp> = { ja: templatePattern("script.whoPlace", "ja"), en: templatePattern("script.whoPlace", "en") };

/** What was filled into a fixed line of the episode's language; the whole line when it matches no template. */
function filledValues(text: string, lang: Lang): string {
  for (const re of FIXED_PATTERNS[lang]) {
    const m = text.match(re);
    if (m) return m.slice(1).flatMap((value) => WHO_PLACE[lang].exec(value)?.slice(1) ?? [value]).join(NAME);
  }
  return text;
}

function windows(text: string): string[] {
  const cps = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i + QUOTE_WINDOW <= cps.length; i++) out.push(cps.slice(i, i + QUOTE_WINDOW).join(""));
  return out;
}

/** Six words in a row, punctuation dropped; the name sentinel counts as a word. */
function wordWindows(text: string): string[] {
  const words = text.match(/[\p{L}\p{N}\u{F0000}]+/gu) ?? [];
  const out: string[] = [];
  for (let i = 0; i + QUOTE_WORDS_EN <= words.length; i++) out.push(words.slice(i, i + QUOTE_WORDS_EN).join(" "));
  return out;
}

/** The rules a non-fixed dj line is held to, by the episode's language. */
const RULES = {
  ja: { topical: TOPICAL, year: null, maskYears: maskDataYears, measure: MEASURE, playback: PLAYBACK, announce: /からのお便りです|お便りを読み|読み上げ/u, windows },
  en: { topical: TOPICAL_EN, year: YEAR_EN, maskYears: maskDataYearsEn, measure: MEASURE_EN, playback: PLAYBACK_EN, announce: ANNOUNCE_EN, windows: wordWindows },
} as const;

/** The intro's first sentence: up to the first 。！？!? or a full stop before a space, or all of it. */
const firstSentence = (text: string): string => text.match(/^[\s\S]*?(?:[。！？!?]|\.(?=\s|$)|$)/u)![0];

/** A title written in Latin letters, digits, punctuation and spaces: it is matched as whole words. */
const LATIN_TITLE = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]+$/u;

/**
 * Whether an intro's first sentence says the work's title again, which the fixed lead has just said. A title of
 * one code point is not checked, since it would turn up by chance. A Latin title counts only where no Latin letter
 * or digit touches it (「Time」 is not in "Sometimes"; 「Blue in Greenは」 still counts); any other title (CJK) as a
 * substring. Normalised and lower-cased on both sides.
 */
function restatesTitle(text: string, item: Item | undefined): boolean {
  const title = item ? norm(item.title).trim().toLowerCase() : "";
  if (Array.from(title).length < 2) return false;
  const head = firstSentence(text).toLowerCase();
  if (!LATIN_TITLE.test(title)) return head.includes(title);
  return new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escapeRe(title)}(?![\\p{Script=Latin}\\p{N}])`, "u").test(head);
}

/** The longest written text a reading may stand for (`READING_TEXT_MAX` in the unit), in code points. */
const READING_SPAN = 40;
/** One run of katakana in what the voice says: a reading, or katakana the line itself has. */
const KATAKANA_RUN = /[\p{Script=Katakana}ー・]+/gu;

/**
 * Whether `spoken` is `text` with some names replaced by katakana readings and nothing else: every stretch of
 * `spoken` outside its katakana runs is `text`'s own, in order, and each katakana run stands either for itself or
 * for 1 to `READING_SPAN` code points of `text`. A reading cannot add a word that is not katakana. Walked as the set
 * of reachable positions in `text`, so it never backtracks.
 */
function onlyReadings(text: string, spoken: string): boolean {
  const cps = Array.from(text);
  const parts: { s: string[]; reading: boolean }[] = [];
  let at = 0;
  for (const m of spoken.matchAll(KATAKANA_RUN)) {
    if (m.index > at) parts.push({ s: Array.from(spoken.slice(at, m.index)), reading: false });
    parts.push({ s: Array.from(m[0]), reading: true });
    at = m.index + m[0].length;
  }
  if (at < spoken.length) parts.push({ s: Array.from(spoken.slice(at)), reading: false });
  const startsAt = (pos: number, s: string[]) => pos + s.length <= cps.length && s.every((c, i) => cps[pos + i] === c);
  let reach = new Set([0]);
  for (const part of parts) {
    const next = new Set<number>();
    for (const pos of reach) {
      if (startsAt(pos, part.s)) next.add(pos + part.s.length);
      if (part.reading) for (let n = 1; n <= READING_SPAN && pos + n <= cps.length; n++) next.add(pos + n);
    }
    if (next.size === 0) return false;
    reach = next;
  }
  return reach.has(cps.length);
}

/**
 * Lower-cases, then replaces every title and creator with one sentinel code point, in letters and dj
 * lines alike: the DJ may name the work in any case, but a name cannot pad a window, and a copied
 * sentence still matches around it. Used for the quote check only.
 */
function maskNames(items: ReadonlyMap<string, Item>): (text: string) => string {
  const names = [...new Set([...items.values()].flatMap((i) => [norm(i.title).trim().toLowerCase(), norm(i.creator).trim().toLowerCase()]))]
    .filter((n) => n !== "")
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return (text) => text.toLowerCase();
  const re = new RegExp(names.map(escapeRe).join("|"), "gu");
  return (text) => text.toLowerCase().replace(re, NAME);
}

/**
 * The texts a letter line may read in `lang`: Japanese reads `bodyJa` or the original; English reads `bodyEn`
 * or the original, never the Japanese translation. The quote check guards every rendering in either language.
 */
function readable(l: Letter, lang: Lang, forQuotes: boolean): string[] {
  if (forQuotes) return lang === "ja" ? [l.body, l.bodyJa] : [l.body, l.bodyJa, ...(l.bodyEn === null ? [] : [l.bodyEn])];
  return lang === "ja" ? [l.bodyJa, l.body] : [...(l.bodyEn === null ? [] : [l.bodyEn]), l.body];
}

/**
 * What an intro must not say about its letter, normalised and lower-cased: the sender's radio name (2+ code
 * points) and the sender's region (prefecture or state, in Japanese and English). A country alone is never
 * checked: a work's intro names countries naturally (「日本のジャズ」), and the hand-over says it anyway. A
 * letter without codes has its `place` checked unless that is itself a country name. Checked on the masked
 * talk, so a work's title or creator (「東京事変」) never counts as the place.
 */
function senderTerms(l: Letter): string[] {
  const name = norm(l.radioName).trim().toLowerCase();
  const place = norm(l.place).trim().toLowerCase();
  const places = l.placeCountry ? regionLabels(l.placeCountry, l.placeRegion).map((r) => norm(r).toLowerCase()) : place !== "" && !isCountryName(place) ? [place] : [];
  return [...(Array.from(name).length >= 2 ? [name] : []), ...places];
}

/**
 * Deterministic checks on a composed episode; nothing here asks a model. The mechanical guarantee is that
 * every letter is read verbatim from the database and that no dj line shares 10 consecutive code points
 * with any letter, after work titles and creators collapse to one sentinel each; a paraphrase by the DJ is
 * not detectable here and is left to the prompt and the eval. Every dj check runs on normalised text (NFKC,
 * no format characters, collapsed spaces). Lines marked `fixed` are our templates filled with names, places
 * and sources that are shown on screen anyway, so they get only the account and quote checks, and the quote
 * check sees only the filled-in values, never the template wording.
 * A Japanese dj line's `spoken` (names replaced by katakana readings) gets every check its `text` gets, and must be
 * that text with names swapped for katakana and nothing else (`reading:`); an English line never has one.
 * A detail reads `{check}: segment {i} line {j}: {term}` and never carries the dj line itself.
 */
export function verifyEpisode(
  segments: Segment[],
  letters: ReadonlyMap<string, Letter>,
  listener: Pick<Listener, "id" | "mcpToken">,
  items: ReadonlyMap<string, Item> = new Map(),
  lang: Lang = "ja",
): VerifyReport {
  const details: string[] = [];
  let verbatim = true;
  let sources = true;
  let topical = true;
  let pii = true;

  const rules = RULES[lang];
  const mask = maskNames(items);
  const quotes = new Set<string>();
  for (const l of letters.values()) for (const text of readable(l, lang, true)) for (const w of rules.windows(mask(norm(text)))) quotes.add(w);
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
        if (!readable(l, lang, false).includes(line.text)) {
          verbatim = false;
          details.push(`verbatim: ${at}: differs from letter ${l.id}`);
        }
        if (line.radioName !== l.radioName || line.place !== l.place || (line.placeCountry !== undefined && line.placeCountry !== l.placeCountry) || (line.placeRegion !== undefined && line.placeRegion !== l.placeRegion) || line.kind !== l.kind || (line.demo === true) !== l.demo) {
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
      // What the voice says is held to the same rules as what the screen shows; a detail found in both is noted once.
      const seen = new Set<string>();
      const push = (d: string) => {
        if (seen.has(d)) return;
        seen.add(d);
        details.push(d);
      };
      if (line.spoken !== undefined) {
        const item = items.get(seg.itemId);
        const written = norm(item ? applyReadings(line.text, itemReadings(item)) : line.text);
        if (lang !== "ja" || !onlyReadings(written, norm(line.spoken))) {
          topical = false;
          push(`reading: ${at}: the voice says more than the line's names`);
        }
      }
      const check = (said: string, isSpoken: boolean) => {
        const text = norm(said);
        if (!line.fixed) {
          // Titles and creators are data, not talk: 「今夜はブギー・バック」 or 「千本桜」 may be named.
          const talk = mask(text);
          const dated = rules.maskYears(talk, years);
          const day = dated.match(rules.topical) ?? (rules.year ? dated.match(rules.year) : null);
          if (day) {
            topical = false;
            push(`topical: ${at}: ${day[0]}`);
          }
          const count = talk.match(rules.measure);
          if (count) {
            topical = false;
            push(`measure: ${at}: ${count[0]}`);
          }
          const own = line.unit?.part === "intro" ? letters.get(line.unit.letterId) : undefined;
          if (own && senderTerms(own).some((term) => mask(text).includes(term))) {
            topical = false;
            // Never the name itself: details reach the logs.
            push(`intro: ${at}: names the sender`);
          }
          if (!isSpoken && line.unit?.part === "intro" && restatesTitle(text, items.get(seg.itemId))) {
            topical = false;
            push(`lead: ${at}: restates the title`);
          }
        }
        const play = !line.fixed ? mask(text).match(rules.playback) : null;
        if (play) {
          topical = false;
          push(`playback: ${at}: ${play[0]}`);
        }
        // A segment that reads no letter (a reply counts as one) must not hand over to a reader with nothing to read.
        if (!line.fixed && !hasLetter && rules.announce.test(text)) {
          topical = false;
          push(`announce: ${at}: hands over to a letter in a segment with none`);
        }
        if (!line.fixed && EMAIL.test(text)) {
          pii = false;
          push(`pii: ${at}: email address`);
        }
        if (!line.fixed && PHONE.test(text)) {
          pii = false;
          push(`pii: ${at}: phone number`);
        }
        if (!line.fixed && URL_RE.test(text)) {
          pii = false;
          push(`pii: ${at}: url`);
        }
        if (!line.fixed && POSTAL.test(text)) {
          pii = false;
          push(`pii: ${at}: postal code`);
        }
        if (!line.fixed && ADDRESS.test(text)) {
          pii = false;
          push(`pii: ${at}: street address`);
        }
        if (secrets.some((s) => text.includes(s))) {
          pii = false;
          push(`pii: ${at}: listener account`);
        }
        if (rules.windows(mask(line.fixed ? filledValues(text, lang) : text)).some((w) => quotes.has(w))) {
          pii = false;
          push(`pii: ${at}: quotes a letter`);
        }
      };
      check(line.text, false);
      if (line.spoken !== undefined) check(line.spoken, true);
    });
  });

  return { verbatim, sources, topical, pii, details };
}
