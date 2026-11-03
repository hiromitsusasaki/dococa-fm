import { fetchJson, yearOf } from "./http";
import type { ItemDraft } from "./index";

type Movie = { id?: number; title?: string; release_date?: string; poster_path?: string | null };

export async function searchTmdb(query: string, apiKey: string): Promise<ItemDraft[]> {
  if (!apiKey) return [];
  const qs = new URLSearchParams({ query, language: "ja-JP" });
  const body = await fetchJson<{ results?: Movie[] }>(`https://api.themoviedb.org/3/search/movie?${qs}`, {
    Authorization: `Bearer ${apiKey}`,
  });
  return (body?.results ?? []).slice(0, 5).flatMap((m): ItemDraft[] =>
    m.id === undefined || !m.title
      ? []
      : [
          {
            kind: "film",
            title: m.title,
            creator: "",
            year: yearOf(m.release_date),
            imageUrl: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
            previewUrl: null,
            outLinks: { tmdb: `https://www.themoviedb.org/movie/${m.id}` },
            externalIds: { tmdb: String(m.id) },
          },
        ],
  );
}
