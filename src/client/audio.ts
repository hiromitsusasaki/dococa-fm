/** Audio helpers: clips (cloud TTS) and the bed under the DJ. */

/** A short silent clip: playing it inside a tap is what lets the element play later without one (iOS Safari). */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export type ClipPlayer = {
  /** Call synchronously inside the tap: starts the one shared element so later `play` calls are allowed. */
  unlock(): void;
  /** Plays `url` until it ends, `seconds` pass, or `signal` aborts. Always resolves: false when the clip failed (error event, non-2xx, play refused), true otherwise. */
  play(url: string, signal: AbortSignal, seconds?: number): Promise<boolean>;
  /** 0..1, applied to the shared element now and whenever it is created. */
  setVolume(volume: number): void;
};

/** One reusable element for every TTS clip: a fresh `new Audio` per clip would lose the tap's permission. `onCreate` sees it once, when it is made. */
export function createClipPlayer(onCreate?: (el: HTMLAudioElement) => void): ClipPlayer {
  let audio: HTMLAudioElement | null = null;
  let volume = 1;
  const element = () => {
    if (audio) return audio;
    audio = Object.assign(new Audio(), { volume });
    onCreate?.(audio);
    return audio;
  };
  return {
    setVolume(v) {
      volume = v;
      if (audio) audio.volume = v;
    },
    unlock() {
      const a = element();
      a.src = SILENT_WAV;
      a.play().catch(() => {});
    },
    play(url, signal, seconds) {
      return new Promise<boolean>((resolve) => {
        const a = element();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (ok = true) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onEnded);
          a.removeEventListener("ended", onEnded);
          a.removeEventListener("error", onError);
          a.pause();
          resolve(ok);
        };
        const onEnded = () => finish();
        const onError = () => finish(false);
        a.addEventListener("ended", onEnded);
        a.addEventListener("error", onError);
        signal.addEventListener("abort", onEnded);
        if (seconds !== undefined) timer = setTimeout(onEnded, seconds * 1000);
        a.src = url;
        a.play().catch(onError);
      });
    },
  };
}

/** iOS (and iPadOS, which says it is a Mac): `volume` is read-only there, so nothing can fade. */
export const isIOS = (): boolean => typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export const BED_URLS = ["/bed-1.mp3", "/bed-2.mp3", "/bed-3.mp3", "/bed-4.mp3", "/bed-5.mp3"];
// The beds are about -24 LUFS, so 0.3 puts them roughly 18 dB under the voice.
const BED_VOLUME = 0.3;

export type Bed = { unlock(): void; start(): void; stop(): void; setVolume(volume: number): void };

/**
 * The bed under the DJ: the tracks play like a record on repeat. The first is picked at random; when one ends the next
 * follows in order, and after the last the first comes round again. An episode change leaves it alone, so a track is
 * never cut mid-way; only the switch stops it, and `start` picks it up where it paused. One element, so a track that
 * ends can start the next without a gesture (iOS Safari).
 */
export function createBed(opts: { urls?: string[] } = {}): Bed {
  const urls = opts.urls ?? BED_URLS;
  let el: HTMLAudioElement | undefined;
  let index = 0;
  let level = BED_VOLUME;
  const element = () => {
    if (!el) {
      index = Math.floor(Math.random() * urls.length);
      el = Object.assign(new Audio(), { loop: urls.length === 1, volume: level, src: urls[index]! });
      el.addEventListener("ended", () => {
        index = (index + 1) % urls.length;
        el!.src = urls[index]!;
        el!.play().catch(() => {});
      });
    }
    return el;
  };
  return {
    /** The listener's volume (0..1) scales the bed's own quiet level. */
    setVolume(v) {
      level = BED_VOLUME * v;
      if (el) el.volume = level;
    },
    /** Inside the tap: lets the element play later without a gesture (iOS Safari). */
    unlock() {
      const a = element();
      a.play().catch(() => {});
      a.pause();
    },
    start() {
      element().play().catch(() => {});
    },
    stop() {
      el?.pause();
    },
  };
}
