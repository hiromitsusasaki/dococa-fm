import { fetchJson, yearOf } from "./http";
import type { ItemDraft } from "./index";

type Movie = { id?: number; title?: string; release_date?: string; poster_path?: string | null };

function toDraft(m: Movie): ItemDraft | null {
  if (m.id === undefined || !m.title) return null;
  return {
    kind: "film",
    title: m.title,
    creator: "",
    year: yearOf(m.release_date),
    imageUrl: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
    previewUrl: null,
    outLinks: { tmdb: `https://www.themoviedb.org/movie/${m.id}` },
    externalIds: { tmdb: String(m.id) },
  };
}

export async function searchTmdb(query: string, apiKey: string): Promise<ItemDraft[]> {
  if (!apiKey) return [];
  const qs = new URLSearchParams({ query, language: "ja-JP" });
  const body = await fetchJson<{ results?: Movie[] }>(`https://api.themoviedb.org/3/search/movie?${qs}`, {
    Authorization: `Bearer ${apiKey}`,
  });
  return (body?.results ?? []).slice(0, 5).flatMap((m) => toDraft(m) ?? []);
}

/** One film by its TMDB id (a search result's link comes back here). */
export async function lookupTmdb(id: string, apiKey: string): Promise<ItemDraft | null> {
  if (!apiKey || !/^\d+$/.test(id)) return null;
  const body = await fetchJson<Movie>(`https://api.themoviedb.org/3/movie/${id}?language=ja-JP`, { Authorization: `Bearer ${apiKey}` });
  return body ? toDraft(body) : null;
}
