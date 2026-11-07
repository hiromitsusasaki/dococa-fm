import { getListener, setStationSlugIfNone } from "../db/listeners";
import type { Env } from "../env";
import { type Lang, t } from "../i18n/t";
import type { Listener } from "../types";

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
  // The owner's own radio name; never the Google display name, and an owner without one is anonymous.
  return t("station.public", { name: ownerName || t("listener.anonymous", undefined, lang) }, lang);
}

/** Where a public station lives; the one builder for `/me`, the settings page and the og tags. */
export const stationUrl = (env: Pick<Env, "PUBLIC_ORIGIN">, slug: string): string => `${env.PUBLIC_ORIGIN}/stations/s:${slug}`;

/** Random lower-case base36 characters, drawn without modulo bias, for an automatic slug or a collision suffix. */
export function slugSuffix(length = 4): string {
  let out = "";
  while (out.length < length) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b! < 252) out += (b! % 36).toString(36); // 252 = 7 * 36, so every character is equally likely
  }
  return out;
}

const MAX_SLUG_ATTEMPTS = 3;

/**
 * The listener's public radio address: the one they have, or a fresh `radio-<6 chars>` that is saved and returned.
 * A collision with another listener's slug draws again, up to three times.
 */
export async function ensureStationSlug(db: D1Database, listener: Listener, suffix: (length: number) => string = slugSuffix): Promise<string> {
  if (listener.stationSlug) return listener.stationSlug;
  for (let attempt = 1; ; attempt++) {
    try {
      await setStationSlugIfNone(db, listener.id, `radio-${suffix(6)}`);
      break;
    } catch (e) {
      if (!String((e as Error)?.message ?? e).includes("station_slug") || attempt >= MAX_SLUG_ATTEMPTS) throw e;
    }
  }
  // Read back: a concurrent request may have assigned one first.
  return (await getListener(db, listener.id))?.stationSlug ?? "";
}
