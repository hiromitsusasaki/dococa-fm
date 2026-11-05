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
