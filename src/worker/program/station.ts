import type { Env } from "../env";
import { type Lang, t } from "../i18n/t";

/** What a listener tunes to: everyone's far shelf, their own radio, or another listener's public favourites. */
export type StationKey = { kind: "world" } | { kind: "mine" } | { kind: "public"; ownerId: string };

export type ParsedStationKey = { kind: "world" } | { kind: "mine" } | { kind: "public"; slug: string };

export const SLUG = /^[a-z0-9-]{3,24}$/;

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

/** The value stored in `episodes.station`; `mine` is also what an episode made outside any station gets. */
export function stationColumn(key: StationKey | undefined): string {
  if (!key || key.kind === "mine") return "mine";
  return key.kind === "world" ? "world" : `public:${key.ownerId}`;
}

export function stationLabel(key: StationKey, ownerName: string, lang: Lang): string {
  if (key.kind === "world") return t("station.world", undefined, lang);
  if (key.kind === "mine") return t("station.mine", undefined, lang);
  return t("station.public", { name: ownerName }, lang);
}

/** Where a public station lives; the one builder for `/me`, the settings page and the og tags. */
export const stationUrl = (env: Pick<Env, "PUBLIC_ORIGIN">, slug: string): string => `${env.PUBLIC_ORIGIN}/stations/s:${slug}`;

/** Four random base36 characters, for a slug that would otherwise collide or be empty. */
export const slugSuffix = (): string => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => (b % 36).toString(36)).join("");

/** A slug from a display name: lower-case ascii words joined by hyphens, at most 24 characters. Too short to be a slug gets `radio-` and a random suffix. */
export function slugFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "");
  return slug.length >= 3 ? slug : `radio-${slugSuffix()}`;
}
