import type { Letter, Listener, Segment, VerifyReport } from "../types";
import { TOPICAL } from "./topical-words";

/** Counting or ranking people and works. 「一通」 alone stays: it is how the program names a letter. */
const MEASURE =
  /[0-9]+ ?(?:通|人|名|位|件|票|回再生|%|パーセント)|[二三四五六七八九十百千万]+(?:通|人|名|位|件|票)|何(?:通|人|件)も|第[0-9一二三四五六七八九十]+位|ランキング|ナンバーワン|一致率|再生回数/u;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
const PHONE = /\d{2,4}-\d{2,4}-\d{3,4}|\d{10,}/u;
const URL_RE = /https?:\/\//iu;
/** A letter this long found inside a dj line is a quote, not a coincidence. */
const QUOTE_MIN = 10;

const nonEmpty = (s: string | null) => s !== null && s.trim() !== "";

/**
 * Deterministic checks on a composed episode; nothing here asks a model. Text is NFKC-normalised for the
 * word checks so full-width digits and letters cannot slip past.
 */
export function verifyEpisode(segments: Segment[], letters: Map<string, Letter>, listener: Listener): VerifyReport {
  const details: string[] = [];
  let verbatim = true;
  let sources = true;
  let topical = true;
  let pii = true;

  const quotable = [...letters.values()]
    .flatMap((l) => [l.body, l.bodyJa])
    .filter((s) => Array.from(s).length >= QUOTE_MIN);
  const secrets = [listener.id, listener.mcpToken].filter((s) => s !== "");

  segments.forEach((seg, si) => {
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
      const text = line.text.normalize("NFKC");
      if (TOPICAL.test(text)) {
        topical = false;
        details.push(`topical: ${at} has a word tied to the day`);
      }
      if (MEASURE.test(text)) {
        topical = false;
        details.push(`topical: ${at} counts or ranks`);
      }
      if (EMAIL.test(text) || PHONE.test(text) || URL_RE.test(text)) {
        pii = false;
        details.push(`pii: ${at} has an address, a number or a url`);
      }
      if (secrets.some((s) => line.text.includes(s))) {
        pii = false;
        details.push(`pii: ${at} names the listener's account`);
      }
      if (quotable.some((q) => line.text.includes(q))) {
        pii = false;
        details.push(`pii: ${at} quotes a letter`);
      }
    });
  });

  return { verbatim, sources, topical, pii, details };
}
