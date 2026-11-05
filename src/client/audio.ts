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

/** One reusable element for every TTS clip: a fresh `new Audio` per clip would lose the tap's permission. */
export function createClipPlayer(): ClipPlayer {
  let audio: HTMLAudioElement | null = null;
  let volume = 1;
  const element = () => (audio ??= Object.assign(new Audio(), { volume }));
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

const BED_URL = "/bed.mp3";
const BED_VOLUME = 0.15;

export function createBed(): { unlock(): void; start(): void; stop(): void; setVolume(volume: number): void } {
  let bed: HTMLAudioElement | null = null;
  let level = BED_VOLUME;
  const element = () => (bed ??= Object.assign(new Audio(BED_URL), { loop: true, volume: level }));
  return {
    /** The listener's volume (0..1) scales the bed's own quiet level. */
    setVolume(v) {
      level = BED_VOLUME * v;
      if (bed) bed.volume = level;
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
      bed?.pause();
    },
  };
}
