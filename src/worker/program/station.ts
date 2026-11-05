import { type Lang, t } from "../i18n/t";

/** What a listener tunes to: everyone's far shelf, their own radio, or another listener's public favourites. */
export type StationKey = { kind: "world" } | { kind: "mine" } | { kind: "public"; ownerId: string };

export type ParsedStationKey = { kind: "world" } | { kind: "mine" } | { kind: "public"; slug: string };

const SLUG = /^[a-z0-9-]{3,24}$/;

/** `world`, `mine` or `s:<slug>`; anything else is not a station. */
export function parseStationKey(raw: string): ParsedStationKey | null {
  if (raw === "world") return { kind: "world" };
  if (raw === "mine") return { kind: "mine" };
  if (raw.startsWith("s:")) {
    const slug = raw.slice(2);
    return SLUG.test(slug) ? { kind: "public", slug } : null;
  }
  return null;
}

export function stationLabel(key: StationKey, ownerName: string, lang: Lang): string {
  if (key.kind === "world") return t("station.world", undefined, lang);
  if (key.kind === "mine") return t("station.mine", undefined, lang);
  return t("station.public", { name: ownerName }, lang);
}
