import type { Lang } from "../i18n/t";
import { looksLikeContact } from "../program/pii-patterns";
import type { Letter } from "../types";

/**
 * A letter as the listener should read it: the text in their language as the main text and, when that is a
 * translation, the untouched original. A missing translation falls back to the original, so nothing breaks.
 */
export function displayText(letter: Pick<Letter, "body" | "bodyJa" | "bodyEn" | "lang">, lang: Lang): { main: string; original: string | null } {
  if (letter.lang === lang) return { main: letter.body, original: null };
  return { main: (lang === "ja" ? letter.bodyJa : letter.bodyEn) ?? letter.body, original: letter.body };
}

const MIN_LIMIT = 400;

/**
 * Whether a machine translation may be stored: it must not smuggle in contact details (URL, email, phone, postal code, address), and must not balloon past `max(400, 2 × source)` code points.
 */
export function saneTranslation(source: string, translated: string): boolean {
  if (looksLikeContact(translated)) return false;
  return Array.from(translated).length <= Math.max(MIN_LIMIT, 2 * Array.from(source).length);
}
