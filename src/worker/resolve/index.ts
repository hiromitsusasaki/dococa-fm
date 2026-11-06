import { findItemsByExternalIds, insertItems, newItem } from "../db/items";
import type { Env } from "../env";
import { limitFrom } from "../limits";
import type { Item, ItemKind } from "../types";
import { lookupBook, searchBooks } from "./books";
import { lookupItunes, searchItunes } from "./itunes";
import { fetchOembed } from "./oembed";
import { cleanOgpTitle, fetchOgp } from "./ogp";
import { lookupTmdb, searchTmdb } from "./tmdb";
import { isFetchableUrl, parseKnownUrl, type ParsedUrl, type Provider } from "./url";
import { searchYouTube } from "./youtube";

export type ItemDraft = Omit<Item, "id" | "createdAt">;

const MAX_RESULTS = 5;
const FILM_PROVIDERS: ReadonlySet<string> = new Set<Provider>(["filmarks", "letterboxd", "netflix"]);
/** Providers whose draft already carries the canonical link built from the id: the pasted URL never replaces it. */
const CANONICAL_LINK: ReadonlySet<string> = new Set<Provider>(["tmdb", "google-books"]);
const OUT_LINK_KEY: Record<Provider, string> = {
  spotify: "spotify",
  youtube: "youtube",
  "apple-music": "apple",
  amazon: "amazon",
  filmarks: "filmarks",
  letterboxd: "letterboxd",
  netflix: "netflix",
  tmdb: "tmdb",
  "google-books": "google-books",
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
  book: () => searchBooks(q, env.GOOGLE_BOOKS_API_KEY),
  film: () => searchTmdb(q, env.TMDB_API_KEY),
});

/** Takes the first of each list in turn, then the second of each, so no one provider fills the page. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** YouTube searches per JST day when `YOUTUBE_SEARCH_DAILY_LIMIT` is unset: 80 of the key's ~100 a day, the rest left to the found-voice batch. */
export const DEFAULT_YOUTUBE_SEARCH_DAILY_LIMIT = 80;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * Counts one YouTube search for today (JST) in D1 and says whether it is still within `YOUTUBE_SEARCH_DAILY_LIMIT`
 * (`0` turns YouTube off and counts nothing). A count that cannot be made skips YouTube: the quota is not spent blind.
 */
async function youtubeSearchAllowed(env: Env, now: Date = new Date()): Promise<boolean> {
  const limit = limitFrom(env.YOUTUBE_SEARCH_DAILY_LIMIT, DEFAULT_YOUTUBE_SEARCH_DAILY_LIMIT);
  if (limit === 0) return false;
  const day = new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
  try {
    const row = await env.DB.prepare("INSERT INTO youtube_searches (day, n) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET n = n + 1 RETURNING n")
      .bind(day)
      .first<{ n: number }>();
    return (row?.n ?? Number.POSITIVE_INFINITY) <= limit;
  } catch (e) {
    console.warn("[dococa] youtube search count unavailable", e instanceof Error ? e.name : "unknown error");
    return false;
  }
}

/**
 * `youtube: true` lets "any" also ask YouTube when a key is set. Only the send page's own search passes it: each call
 * costs a hundredth of the day's quota, so it sits behind that page's search limit and a daily cap counted in D1
 * (`YOUTUBE_SEARCH_DAILY_LIMIT`). The first result is always the best guess of the first provider that has one.
 */
export async function searchByText(q: string, kind: ItemKind | "any", env: Env, opts: { limit?: number; youtube?: boolean } = {}): Promise<ItemDraft[]> {
  const limit = opts.limit ?? MAX_RESULTS;
  const by = searchers(q, env);
  if (kind !== "any") return (await orEmpty(by[kind]())).slice(0, limit);
  const youtube = opts.youtube && env.YOUTUBE_API_KEY && (await youtubeSearchAllowed(env)) ? [() => searchYouTube(q, env.YOUTUBE_API_KEY)] : [];
  const results = await Promise.all([by.music, by.book, by.film, ...youtube].map((search) => orEmpty(search())));
  return interleave(results).slice(0, limit);
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

/** A song title shorter than this (code points, normalised) is found inside too many video titles ("So" in "Sometimes"). */
const MIN_TITLE_IN_VIDEO = 4;

const titleWithin = (song: string, video: string): boolean => {
  const s = normalizeName(song);
  return [...s].length >= MIN_TITLE_IN_VIDEO && normalizeName(video).includes(s);
};

export function sameArtist(a: string, b: string): boolean {
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
    outLinks: CANONICAL_LINK.has(parsed.provider) ? draft.outLinks : { ...draft.outLinks, [OUT_LINK_KEY[parsed.provider]]: url },
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
  // A video title is free text ("Artist - Song (Official Audio)"), so a hit is taken only when its title is in it.
  const found = artist ? hits.find((h) => sameArtist(h.creator, artist)) : hits.find((h) => titleWithin(h.title, oembed.title));
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
  // Only the id decides what these are; their pages are never read, so a look-alike page cannot name the work.
  if (parsed.provider === "tmdb" && parsed.id) {
    const film = await orNull(lookupTmdb(parsed.id, env.TMDB_API_KEY));
    return film && withOrigin(film, parsed, url);
  }
  if (parsed.provider === "google-books" && parsed.id) {
    const book = await orNull(lookupBook(parsed.id, env.GOOGLE_BOOKS_API_KEY));
    return book && withOrigin(book, parsed, url);
  }
  if (parsed.provider === "apple-music" && parsed.id) {
    const track = await orNull(lookupItunes(parsed.id));
    if (track) return withOrigin(track, parsed, url);
  }
  if (parsed.provider === "amazon" && parsed.id && /^\d/.test(parsed.id)) {
    const [book] = await orEmpty(searchBooks(`isbn:${parsed.id}`, env.GOOGLE_BOOKS_API_KEY));
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
  const [item] = await resolveOrCreateMany(db, [draft]);
  return item as Item;
}

/**
 * `resolveOrCreate` for many drafts with one lookup and one batched insert, in order: a later draft that is
 * the same work as an earlier new one resolves to it, not to a second row.
 */
export async function resolveOrCreateMany(db: D1Database, drafts: ItemDraft[]): Promise<Item[]> {
  const pairs = [...new Map(drafts.flatMap((d) => Object.entries(d.externalIds)).map(([k, v]) => [`${k}\u0000${v}`, [k, v] as [string, string]])).values()];
  const known = pairs.length > 0 ? await findItemsByExternalIds(db, pairs) : [];
  const created: Item[] = [];
  const out: Item[] = [];
  for (const draft of drafts) {
    const tried: Array<[string, string]> = [];
    let match: Item | undefined;
    for (const [key, value] of Object.entries(draft.externalIds)) {
      const existing = known.find((i) => i.externalIds[key] === value);
      if (existing && tried.every(([k, v]) => existing.externalIds[k] === undefined || existing.externalIds[k] === v)) {
        match = existing;
        break;
      }
      tried.push([key, value]);
    }
    if (!match) {
      match = newItem(draft);
      created.push(match);
      known.push(match);
    }
    out.push(match);
  }
  await insertItems(db, created);
  return out;
}
