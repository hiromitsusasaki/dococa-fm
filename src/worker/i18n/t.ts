import { en } from "./en";
import { ja } from "./ja";

type Key = keyof typeof ja;

export type Lang = "ja" | "en";

const tables: Record<Lang, Record<Key, string>> = { ja, en };

/** `{name}` placeholders are replaced from params; nothing else is interpolated. */
export function t(key: Key, params?: Record<string, string>, lang: Lang = "ja"): string {
  const text = tables[lang][key];
  return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m) : text;
}

/** `t` with the language fixed, so a page or component binds it once from the listener's language. */
export const tFor =
  (lang: Lang) =>
  (key: Key, params?: Record<string, string>): string =>
    t(key, params, lang);

/** The first language tag decides: `en` or `en-*` is English, anything else (or nothing) is Japanese. */
export function langFromAcceptLanguage(header: string | undefined): Lang {
  const first = header?.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return first === "en" || first.startsWith("en-") ? "en" : "ja";
}
