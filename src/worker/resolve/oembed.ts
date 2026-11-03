import { fetchJson } from "./http";

export type Oembed = { title: string; author: string | null; thumbnail: string | null };

type Raw = { title?: string; author_name?: string; thumbnail_url?: string };

export async function fetchOembed(provider: "spotify" | "youtube", url: string): Promise<Oembed | null> {
  const endpoint =
    provider === "spotify"
      ? `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`
      : `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const body = await fetchJson<Raw>(endpoint);
  if (!body?.title) return null;
  return { title: body.title, author: body.author_name ?? null, thumbnail: body.thumbnail_url ?? null };
}
