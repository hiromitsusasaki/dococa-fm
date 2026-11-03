import { fetchJson, yearOf } from "./http";
import type { ItemDraft } from "./index";

type ItunesTrack = {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
  releaseDate?: string;
};
type ItunesResponse = { results?: ItunesTrack[] };

function toDraft(t: ItunesTrack): ItemDraft | null {
  if (t.trackId === undefined || !t.trackName) return null;
  return {
    kind: "music",
    title: t.trackName,
    creator: t.artistName ?? "",
    year: yearOf(t.releaseDate),
    imageUrl: t.artworkUrl100 ? t.artworkUrl100.replace("100x100", "600x600") : null,
    previewUrl: t.previewUrl ?? null,
    outLinks: t.trackViewUrl ? { apple: t.trackViewUrl } : {},
    externalIds: { itunes: String(t.trackId) },
  };
}

const toDrafts = (body: ItunesResponse | null): ItemDraft[] =>
  (body?.results ?? []).flatMap((t) => toDraft(t) ?? []);

export async function searchItunes(term: string): Promise<ItemDraft[]> {
  const qs = new URLSearchParams({ term, media: "music", entity: "song", limit: "5", country: "JP" });
  return toDrafts(await fetchJson<ItunesResponse>(`https://itunes.apple.com/search?${qs}`));
}

export async function lookupItunes(id: string): Promise<ItemDraft | null> {
  const qs = new URLSearchParams({ id, country: "JP" });
  return toDrafts(await fetchJson<ItunesResponse>(`https://itunes.apple.com/lookup?${qs}`))[0] ?? null;
}
