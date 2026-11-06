import { fetchJson } from "./http";
import type { ItemDraft } from "./index";

type Video = {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; thumbnails?: { high?: { url?: string } } };
};

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
/** The search API returns titles HTML-escaped ("Don&#39;t"); the page escapes them again on its own. */
const unescapeHtml = (s: string) => s.replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e]!);

/** Videos by title. Without a key it asks nothing. The key rides in a header, never the url, so it stays out of any log. */
export async function searchYouTube(q: string, key: string): Promise<ItemDraft[]> {
  if (!key) return [];
  const qs = new URLSearchParams({ part: "snippet", type: "video", maxResults: "5", q });
  const body = await fetchJson<{ items?: Video[] }>(`https://www.googleapis.com/youtube/v3/search?${qs}`, { "X-Goog-Api-Key": key });
  return (body?.items ?? []).flatMap((v): ItemDraft[] => {
    const id = v.id?.videoId;
    const title = unescapeHtml(v.snippet?.title ?? "");
    if (!id || !title) return [];
    return [
      {
        kind: "music",
        title,
        creator: unescapeHtml(v.snippet?.channelTitle ?? ""),
        year: null,
        imageUrl: v.snippet?.thumbnails?.high?.url ?? null,
        previewUrl: null,
        outLinks: { youtube: `https://www.youtube.com/watch?v=${id}` },
        externalIds: { youtube: id },
      },
    ];
  });
}
