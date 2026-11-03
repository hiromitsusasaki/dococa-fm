import { findItemByExternalId, insertItem } from "../db/items";
import type { Env } from "../env";
import type { Item, ItemKind } from "../types";
import { searchBooks } from "./books";
import { lookupItunes, searchItunes } from "./itunes";
import { fetchOembed } from "./oembed";
import { cleanOgpTitle, fetchOgp } from "./ogp";
import { searchTmdb } from "./tmdb";
import { isFetchableUrl, parseKnownUrl, type ParsedUrl, type Provider } from "./url";

export type ItemDraft = Omit<Item, "id" | "createdAt">;

const MAX_RESULTS = 5;
const FILM_PROVIDERS: ReadonlySet<string> = new Set<Provider>(["filmarks", "letterboxd", "netflix"]);
const OUT_LINK_KEY: Record<Provider, string> = {
  spotify: "spotify",
  youtube: "youtube",
  "apple-music": "apple",
  amazon: "amazon",
  filmarks: "filmarks",
  letterboxd: "letterboxd",
  netflix: "netflix",
};

/** One provider failing (network, timeout) must not take the others down. */
async function orEmpty(search: Promise<ItemDraft[]>): Promise<ItemDraft[]> {
  try {
    return await search;
  } catch {
    return [];
  }
}

const searchers = (q: string, env: Env): Record<ItemKind, () => Promise<ItemDraft[]>> => ({
  music: () => searchItunes(q),
  book: () => searchBooks(q),
  film: () => searchTmdb(q, env.TMDB_API_KEY),
});

export async function searchByText(q: string, kind: ItemKind | "any", env: Env): Promise<ItemDraft[]> {
  const by = searchers(q, env);
  if (kind !== "any") return (await orEmpty(by[kind]())).slice(0, MAX_RESULTS);
  const results = await Promise.all([by.music, by.book, by.film].map((search) => orEmpty(search())));
  return results.flat().slice(0, MAX_RESULTS);
}

async function orNull<T>(op: Promise<T>): Promise<T | null> {
  try {
    return await op;
  } catch {
    return null;
  }
}

/** Spotify's og:description reads "Artist · Song · 2019" or "Artist · Album · Song · 2019". */
function artistFromDescription(description: string | null | undefined): string | null {
  const parts = (description ?? "").split(" · ");
  return parts.length >= 2 && parts[0]!.trim() ? parts[0]!.trim() : null;
}

const normalizeName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

function sameArtist(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x !== "" && y !== "" && (x.includes(y) || y.includes(x));
}

/** First kind that has a hit, in the order iTunes, Google Books, TMDB. */
async function searchFirstKind(q: string, env: Env): Promise<ItemDraft | null> {
  const by = searchers(q, env);
  for (const search of [by.music, by.book, by.film]) {
    const [hit] = await orEmpty(search());
    if (hit) return hit;
  }
  return null;
}

/** Records where the item was pasted from: the pasted url as an out link and the provider's own id. */
function withOrigin(draft: ItemDraft, parsed: ParsedUrl, url: string): ItemDraft {
  if (parsed.provider === "unknown") return draft;
  return {
    ...draft,
    outLinks: { ...draft.outLinks, [OUT_LINK_KEY[parsed.provider]]: url },
    // The pasted provider's own id goes first: resolveOrCreate dedupes in this order, so it outranks an iTunes guess.
    externalIds: { ...(parsed.id ? { [parsed.provider]: parsed.id } : {}), ...draft.externalIds },
  };
}

async function resolveOembed(provider: "spotify" | "youtube", parsed: ParsedUrl, url: string): Promise<ItemDraft | null> {
  const [oembed, ogp] = await Promise.all([
    orNull(fetchOembed(provider, url)),
    provider === "spotify" ? orNull(fetchOgp(url)) : Promise.resolve(null),
  ]);
  if (!oembed) return null;
  const artist = provider === "spotify" ? artistFromDescription(ogp?.description) : null;
  const author = provider === "youtube" ? oembed.author : artist;
  // YouTube's author is a channel, not an artist, so only a Spotify artist is checked against the hit.
  const hits = await orEmpty(searchItunes(author ? `${oembed.title} ${author}` : oembed.title));
  const found = artist ? hits.find((h) => sameArtist(h.creator, artist)) : hits[0];
  const base: ItemDraft = found ?? {
    kind: "music",
    title: oembed.title,
    creator: author ?? "",
    year: null,
    imageUrl: oembed.thumbnail,
    previewUrl: null,
    outLinks: {},
    externalIds: {},
  };
  return withOrigin(base, parsed, url);
}

async function resolveOgp(parsed: ParsedUrl, url: string, env: Env, isbn?: string): Promise<ItemDraft | null> {
  const ogp = await fetchOgp(url);
  if (!ogp) return null;
  const cleaned = cleanOgpTitle(parsed.provider === "unknown" ? "amazon" : parsed.provider, ogp.title);
  const fromOgp = (kind: ItemKind): ItemDraft => ({
    kind,
    title: cleaned.title,
    creator: "",
    year: cleaned.year,
    imageUrl: ogp.image,
    previewUrl: null,
    outLinks: {},
    externalIds: isbn ? { isbn } : {},
  });
  if (FILM_PROVIDERS.has(parsed.provider)) return withOrigin(fromOgp("film"), parsed, url);
  if (isbn) return withOrigin(fromOgp("book"), parsed, url);
  const found = await searchFirstKind(ogp.title, env);
  return found ? withOrigin(found, parsed, url) : null;
}

async function resolveKnown(url: string, env: Env): Promise<ItemDraft | null> {
  const parsed = parseKnownUrl(url);
  if ((parsed.provider === "spotify" || parsed.provider === "youtube") && parsed.id) {
    return resolveOembed(parsed.provider, parsed, url);
  }
  if (parsed.provider === "apple-music" && parsed.id) {
    const track = await orNull(lookupItunes(parsed.id));
    if (track) return withOrigin(track, parsed, url);
  }
  if (parsed.provider === "amazon" && parsed.id && /^\d/.test(parsed.id)) {
    const [book] = await orEmpty(searchBooks(`isbn:${parsed.id}`));
    if (book) return withOrigin({ ...book, externalIds: { ...book.externalIds, isbn: book.externalIds.isbn ?? parsed.id } }, parsed, url);
    return resolveOgp(parsed, url, env, parsed.id);
  }
  return resolveOgp(parsed, url, env);
}

/** Turns a pasted url into an item draft, or null when it cannot be understood. Never throws. */
export async function resolveUrl(url: string, env: Env): Promise<ItemDraft | null> {
  if (!isFetchableUrl(url)) return null;
  try {
    return await resolveKnown(url, env);
  } catch {
    return null;
  }
}

/**
 * Returns the stored item that shares an external id with the draft, or stores the draft as new.
 * Keys are tried in order, and a hit is rejected when it holds a different value for a key tried
 * before it. So a different Spotify id is never merged into another track through a shared iTunes guess.
 */
export async function resolveOrCreate(db: D1Database, draft: ItemDraft): Promise<Item> {
  const tried: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(draft.externalIds)) {
    const existing = await findItemByExternalId(db, key, value);
    if (existing && tried.every(([k, v]) => existing.externalIds[k] === undefined || existing.externalIds[k] === v)) {
      return existing;
    }
    tried.push([key, value]);
  }
  return insertItem(db, draft);
}
