import type { Lang } from "../i18n/t";
import { COUNTRIES, REGIONS, type Place } from "./places";

const byCode = (list: readonly Place[], code: string | null | undefined) => (code ? list.find((p) => p.code === code) : undefined);

const regionsOf = (country: string | null | undefined): readonly Place[] | undefined =>
  country === "JP" || country === "US" ? REGIONS[country] : undefined;

/** A region is valid when empty, or when it is on the list of a country that has one. */
export function isValidRegion(country: string | null | undefined, region: string | null | undefined): boolean {
  if (!region) return true;
  return byCode(regionsOf(country) ?? [], region) !== undefined;
}

/** The coarse place a letter and the DJ show: "島根", "Tokyo, Japan", "ポルトガル". Empty when there is none. */
export function placeLabel(country: string | null, region: string | null, lang: Lang): string {
  const c = byCode(COUNTRIES, country);
  if (!c) return "";
  const r = byCode(regionsOf(country) ?? [], region);
  if (country === "JP" && r) return lang === "ja" ? r.ja.replace(/[都府県]$/, "") : `${r.en}, ${c.en}`;
  if (country === "US" && r) return lang === "ja" ? `${r.ja}、${c.ja}` : `${r.en}, USA`;
  return (lang === "ja" ? c.ja : c.en) || c.en;
}

/** Names of parts of a listed country, said like a country (the settings list has the United Kingdom only). */
const COUNTRY_ALIASES = ["スコットランド", "イングランド", "ウェールズ", "北アイルランド", "scotland", "england", "wales", "northern ireland"];

/** Whether `name` (already normalised) is a country: a label of the list in either language, or a known alias. */
export function isCountryName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n !== "" && (COUNTRIES.some((c) => c.ja.toLowerCase() === n || c.en.toLowerCase() === n) || COUNTRY_ALIASES.includes(n));
}

/** The region alone, in Japanese (with and without 都/府/県/州) and English: 「東京都」「東京」「Tokyo」. Empty without a listed region. */
export function regionLabels(country: string | null, region: string | null): string[] {
  const r = byCode(regionsOf(country) ?? [], region);
  if (!r) return [];
  return [...new Set([r.ja, r.ja.replace(/[都府県州]$/u, ""), r.en])].filter((s) => s !== "");
}
