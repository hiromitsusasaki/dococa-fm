/** Audio helpers: clips (previews, cloud TTS) and the bed under the DJ. */

/** A short silent clip: playing it inside a tap is what lets the element play later without one (iOS Safari). */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export type ClipPlayer = {
  /** Call synchronously inside the tap: starts the one shared element so later `play` calls are allowed. */
  unlock(): void;
  /** Plays `url` until it ends, errors, `seconds` pass, or `signal` aborts. Always resolves. */
  play(url: string, signal: AbortSignal, seconds?: number): Promise<void>;
};

/** One reusable element for every preview and TTS clip: a fresh `new Audio` per clip would lose the tap's permission. */
export function createClipPlayer(): ClipPlayer {
  let audio: HTMLAudioElement | null = null;
  const element = () => (audio ??= new Audio());
  return {
    unlock() {
      const a = element();
      a.src = SILENT_WAV;
      a.play().catch(() => {});
    },
    play(url, signal, seconds) {
      return new Promise((resolve) => {
        const a = element();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          a.removeEventListener("ended", finish);
          a.removeEventListener("error", finish);
          a.pause();
          resolve();
        };
        a.addEventListener("ended", finish);
        a.addEventListener("error", finish);
        signal.addEventListener("abort", finish);
        if (seconds !== undefined) timer = setTimeout(finish, seconds * 1000);
        a.src = url;
        a.play().catch(finish);
      });
    },
  };
}

const BED_URL = "/bed.mp3";
const BED_VOLUME = 0.15;

export function createBed(): { unlock(): void; start(): void; stop(): void } {
  let bed: HTMLAudioElement | null = null;
  const element = () => (bed ??= Object.assign(new Audio(BED_URL), { loop: true, volume: BED_VOLUME }));
  return {
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
