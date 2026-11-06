/** Line playback shared by the episode player and the station player: cloud and Web Speech talk, the bed, Media Session. */
import { siteLabel, whoLine } from "../worker/letters/label";
import type { ScriptLine, Segment } from "../worker/types";
import { createBed, createClipPlayer } from "./audio";
import { loadVoices, pickVoice, speak } from "./speech";

export type PlayerItem = {
  title: string;
  creator: string;
  imageUrl: string | null;
  outLinks: Record<string, string>;
  /** `music` / `book` / `film`, for the label; older pages leave it out. */
  kind?: string;
  year?: number | null;
};
/** What the screen shows for a letter: the text in the listener's language and, behind a toggle, the original when that is a translation. The DJ reads the script line as it is. */
export type PlayerOriginals = Record<string, { main: string; original: string | null }>;
/** The slice of an episode the page embeds: no listener id, no verification report. */
export type PlayerEpisode = {
  id: string;
  segments: Segment[];
  items: Record<string, PlayerItem>;
  originals?: PlayerOriginals;
  /** The stored line each shown line is, for `/tts`: the page may leave out letters rejected after the episode was made. */
  ttsLines?: number[];
  /** False when the episode has no cloud voice; the browser voice reads it. Absent means the page's `ttsUrl` decides. */
  cloudTts?: boolean;
};
export type LetterLine = Extract<ScriptLine, { type: "letter" }>;

export const isHttpUrl = (s: string | null | undefined): s is string => typeof s === "string" && /^https?:\/\//i.test(s);
export const fmt = (tpl: string, params: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m);

/** Index of a line across the whole stored episode, which is what the TTS endpoint takes. */
const globalIndex = (episode: PlayerEpisode, seg: number, line: number) => {
  const shown = episode.segments.slice(0, seg).reduce((n, s) => n + s.lines.length, 0) + line;
  return episode.ttsLines?.[shown] ?? shown;
};

/** The line after (seg, line), or null at the end of the episode. */
function nextSpoken(segments: Segment[], seg: number, line: number): [number, number] | null {
  for (let i = seg, j = line + 1; i < segments.length; i++, j = 0) if (j < segments[i]!.lines.length) return [i, j];
  return null;
}

export type LinePlayer = {
  /** Call synchronously inside the tap: starts the speech engine, the shared clip element and the bed so later sound is allowed (iOS Safari). */
  unlock(): void;
  /** 0..1: the clips' volume, and the bed at its own level times this. */
  setVolume(volume: number): void;
  /** Reads one line and resolves when it is done or `signal` aborts. */
  play(episode: PlayerEpisode, seg: number, line: number, signal: AbortSignal): Promise<void>;
  /** Stops the bed under the DJ. */
  stopBed(): void;
};

export function createLinePlayer(opts: { voiceURI: string; ttsUrl: string | null }): LinePlayer {
  const bed = createBed();
  const clips = createClipPlayer();
  let unlocked = false;
  let voices: SpeechSynthesisVoice[] | null = null;
  /** Episodes whose cloud clip failed once: the rest of that episode is read by the browser voice. */
  const cloudFailed = new Set<string>();
  const warmed = new Set<string>();

  const ttsSrc = (episode: PlayerEpisode, seg: number, line: number) =>
    `${opts.ttsUrl}?episode=${encodeURIComponent(episode.id)}&line=${globalIndex(episode, seg, line)}`;
  const cloudOn = (episode: PlayerEpisode) => opts.ttsUrl !== null && episode.cloudTts !== false && !cloudFailed.has(episode.id);

  /**
   * While a cloud clip plays, asks for the next spoken line so the server synthesizes and stores it now;
   * the clip element then gets it from R2 (or the HTTP cache) instead of waiting seconds for synthesis.
   */
  function warmNext(episode: PlayerEpisode, seg: number, line: number) {
    const next = nextSpoken(episode.segments, seg, line);
    if (!next) return;
    const src = ttsSrc(episode, next[0], next[1]);
    if (warmed.has(src)) return;
    warmed.add(src);
    void fetch(src).catch(() => {});
  }

  return {
    unlock() {
      if (unlocked) return;
      unlocked = true;
      clips.unlock();
      bed.unlock();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    },
    setVolume(volume) {
      clips.setVolume(volume);
      bed.setVolume(volume);
    },
    stopBed: () => bed.stop(),
    async play(episode, seg, index, signal) {
      const line = episode.segments[seg]?.lines[index];
      // Only talk airs; the server no longer sends a preview clip, and one that slips through is not played.
      if (!line || line.type === "preview") return;
      bed.start();
      if (cloudOn(episode)) {
        warmNext(episode, seg, index);
        const played = await clips.play(ttsSrc(episode, seg, index), signal);
        if (played || signal.aborted) return;
        cloudFailed.add(episode.id);
      }
      voices ??= await loadVoices();
      if (!signal.aborted) await speak(line.text, pickVoice(voices, opts.voiceURI), signal);
    },
  };
}

/** Lock-screen / headset controls for the work being read. Pass `null` to leave the metadata as it is. */
export function syncMediaSession(item: PlayerItem | undefined, playing: boolean) {
  const ms = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
  if (!ms) return;
  if (item && typeof MediaMetadata !== "undefined") {
    ms.metadata = new MediaMetadata({
      title: item.title,
      artist: item.creator,
      artwork: isHttpUrl(item.imageUrl) ? [{ src: item.imageUrl }] : [],
    });
  }
  ms.playbackState = playing ? "playing" : "paused";
}

export function bindMediaSession(handlers: { play: () => void; pause: () => void; next: () => void }) {
  if (typeof navigator === "undefined" || !navigator.mediaSession) return;
  navigator.mediaSession.setActionHandler("play", handlers.play);
  navigator.mediaSession.setActionHandler("pause", handlers.pause);
  navigator.mediaSession.setActionHandler("nexttrack", handlers.next);
}

/** `out.*` labels are shipped by the server; a service without one is not linked. */
export const outLabel = (str: (key: string) => string, key: string): string | null => {
  const label = str(`out.${key}`);
  return label === `out.${key}` ? null : label;
};

export function foundLabel(l: LetterLine, url: string, str: (key: string) => string): string {
  const site = siteLabel(url);
  return fmt(str(site ? "player.foundSource" : "player.foundSourceNoSite"), { author: l.sourceAuthor ?? "", site });
}

export function whoOf(l: LetterLine, str: (key: string) => string): string {
  if (l.kind === "found") return l.sourceAuthor ?? "";
  // The page's language rides in with the strings; a missing or unknown value reads as Japanese.
  const lang = str("lang.code") === "en" ? "en" : "ja";
  return whoLine(l, (key, params) => fmt(str(key), params ?? {}), lang);
}

export type NextReason = "limit" | "empty" | "failed";

/** Asks for the listener's next episode. The same mapping for both players: 429 is today's limit, 409 is a station with nothing to play. */
export async function fetchNext(url: string): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: NextReason }> {
  try {
    const res = await fetch(url, { method: "POST" });
    if (res.status === 429) return { ok: false, reason: "limit" };
    if (res.status === 409) return { ok: false, reason: "empty" };
    if (!res.ok) return { ok: false, reason: "failed" };
    const body = (await res.json()) as unknown;
    return typeof body === "object" && body !== null ? { ok: true, body: body as Record<string, unknown> } : { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

const reportedListens = new Set<string>();

/** Tests only: a page lives once, so the set is never cleared at run time. */
export const forgetReportedListens = (): void => reportedListens.clear();

/**
 * Tells the server a letter began playing, once per (episode, letter) per page. Fire and forget: the listening
 * record is a convenience, so a failed request never stops the radio.
 */
export function reportListen(url: string, r: { episodeId: string; letterId: string; segmentIndex: number }): void {
  const key = `${r.episodeId}\u0000${r.letterId}`;
  if (reportedListens.has(key)) return;
  reportedListens.add(key);
  try {
    void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) }).catch(() => {});
  } catch {}
}
