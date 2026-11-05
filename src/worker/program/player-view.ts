import { isHttpUrl } from "../../views/components";
import { getItemsByIds } from "../db/items";
import type { Lang } from "../i18n/t";
import type { Episode, Item, Segment } from "../types";
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

type Loaded = Pick<Awaited<ReturnType<typeof loadPublicEpisode>>, "segments" | "originals" | "storedIndex">;

/** The pure part: a page that already holds the loaded letters and works builds the view without reading again. */
export function toPlayerView(episode: Episode, loaded: Loaded, stored: ReadonlyMap<string, Item>): PlayerView {
  const items: Record<string, PlayerItem> = {};
  for (const s of loaded.segments) {
    const item = stored.get(s.itemId);
    if (!item) continue;
    items[item.id] = {
      title: item.title,
      creator: item.creator,
      imageUrl: isHttpUrl(item.imageUrl) ? item.imageUrl : null,
      outLinks: Object.fromEntries(Object.entries(item.outLinks).filter(([, href]) => isHttpUrl(href))),
    };
  }
  return { id: episode.id, segments: loaded.segments, items, originals: loaded.originals, ttsLines: loaded.storedIndex, cloudTts: episode.cloudTts };
}

export async function playerView(db: D1Database, episode: Episode, lang: Lang): Promise<PlayerView> {
  const loaded = await loadPublicEpisode(db, episode, lang);
  return toPlayerView(episode, loaded, await getItemsByIds(db, loaded.segments.map((s) => s.itemId)));
}
