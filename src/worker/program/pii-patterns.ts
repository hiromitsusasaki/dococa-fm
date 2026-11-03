/** Contact details a DJ line must not say and a radio name or place must not be. */
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
export const PHONE = /\d{2,4}-\d{2,4}-\d{3,4}|\d{10,}|\+\d{1,3}[ -]?\d{1,4}[ -]?\d{2,4}[ -]?\d{3,4}/u;
export const URL_RE = /https?:\/\/|www\.|[a-z0-9-]+\.(?:co\.jp|com|net|org|jp|io|fm|tv)\b/iu;

/** NFKC, invisible format characters (zero-width and the like) removed, whitespace collapsed. */
export const normalizeText = (s: string): string => s.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ");

export function looksLikeContact(s: string): boolean {
  const text = normalizeText(s);
  return EMAIL.test(text) || PHONE.test(text) || URL_RE.test(text);
}
