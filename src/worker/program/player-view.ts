import { isHttpUrl } from "../../views/components";
import { getItemsByIds } from "../db/items";
import type { Lang } from "../i18n/t";
import type { Episode, Segment } from "../types";
import { loadPublicEpisode, type Originals } from "./stored";

export type PlayerItem = { title: string; creator: string; imageUrl: string | null; outLinks: Record<string, string> };

/** Everything the client player needs for one episode: what may still air, the works on screen and the letters as read. */
export type PlayerView = {
  id: string;
  segments: Segment[];
  items: Record<string, PlayerItem>;
  originals: Originals;
  /** For each line of `segments` in reading order, its index across the stored episode (the TTS cache key). */
  ttsLines: number[];
  cloudTts: boolean;
};

export async function playerView(db: D1Database, episode: Episode, lang: Lang): Promise<PlayerView> {
  const { segments, originals, storedIndex } = await loadPublicEpisode(db, episode, lang);
  const stored = await getItemsByIds(db, segments.map((s) => s.itemId));
  const items: Record<string, PlayerItem> = {};
  for (const s of segments) {
    const item = stored.get(s.itemId);
    if (!item) continue;
    items[item.id] = {
      title: item.title,
      creator: item.creator,
      imageUrl: isHttpUrl(item.imageUrl) ? item.imageUrl : null,
      outLinks: Object.fromEntries(Object.entries(item.outLinks).filter(([, href]) => isHttpUrl(href))),
    };
  }
  return { id: episode.id, segments, items, originals, ttsLines: storedIndex, cloudTts: episode.cloudTts };
}
