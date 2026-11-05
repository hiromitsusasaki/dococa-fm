import type { Lang } from "../i18n/t";
import type { Letter } from "../types";

/**
 * A letter as the listener should read it: the text in their language as the main text and, when that is a
 * translation, the untouched original. A missing translation falls back to the original, so nothing breaks.
 */
export function displayText(letter: Pick<Letter, "body" | "bodyJa" | "bodyEn" | "lang">, lang: Lang): { main: string; original: string | null } {
  if (letter.lang === lang) return { main: letter.body, original: null };
  return { main: (lang === "ja" ? letter.bodyJa : letter.bodyEn) ?? letter.body, original: letter.body };
}
