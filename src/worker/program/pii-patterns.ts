/** Contact details a DJ line must not say and a radio name or place must not be. */
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
export const PHONE = /\d{2,4}-\d{2,4}-\d{3,4}|\d{10,}|\+\d{1,3}[ -]?\d{1,4}[ -]?\d{2,4}[ -]?\d{3,4}/u;
export const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(?:co\.jp|com|net|org|jp|io|fm|tv)\b/iu;
/** A postal code: with 〒 in any form, or 3-4 digits joined by a hyphen. Seven bare digits are not taken for one. */
export const POSTAL = /〒\s*\d{3}-?\d{4}|(?<![\d-])\d{3}-\d{4}(?![\d-])/u;
const NUM = "[0-9一二三四五六七八九十〇]+";
/**
 * A street address down to the lot: 番地, 番 with 号, 丁目 with 番, a 2-8-1 style triple, or a city/ward/town name followed by a number pair.
 * A bare pair (「2-1」) or a year range (「1990-95 年」) is not an address.
 * 「2丁目のカフェ」 or 「十八番」 alone is not an address.
 */
export const ADDRESS = new RegExp(
  `${NUM}\\s*番地|${NUM}\\s*番\\s*${NUM}\\s*号|${NUM}\\s*丁目\\s*${NUM}\\s*番|(?<![\\d-])\\d{1,3}-\\d{1,3}-\\d{1,4}(?![\\d-])|(?:市|区|町|村)[^\\s\\d、。]{0,8}\\d{1,4}-\\d{1,4}(?![\\d-]|\\s*年)`,
  "u",
);

/** NFKC, invisible format characters (zero-width and the like) removed, whitespace collapsed. */
export const normalizeText = (s: string): string => s.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ");

export function looksLikeContact(s: string): boolean {
  const text = normalizeText(s);
  return EMAIL.test(text) || PHONE.test(text) || URL_RE.test(text) || POSTAL.test(text) || ADDRESS.test(text);
}
