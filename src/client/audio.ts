/** Audio helpers: clips (previews, cloud TTS) and the bed under the DJ. */

/** Plays `url` until it ends, errors, `seconds` pass, or `signal` aborts. Always resolves. */
export function playClip(url: string, signal: AbortSignal, seconds?: number): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      audio.pause();
      resolve();
    };
    audio.addEventListener("ended", finish);
    audio.addEventListener("error", finish);
    signal.addEventListener("abort", finish);
    if (seconds !== undefined) timer = setTimeout(finish, seconds * 1000);
    audio.play().catch(finish);
  });
}

const BED_URL = "/bed.mp3";
const BED_VOLUME = 0.15;

export function createBed(): { start(): void; stop(): void } {
  let bed: HTMLAudioElement | null = null;
  return {
    start() {
      if (!bed) {
        bed = new Audio(BED_URL);
        bed.loop = true;
        bed.volume = BED_VOLUME;
      }
      bed.play().catch(() => {});
    },
    stop() {
      bed?.pause();
    },
  };
}
