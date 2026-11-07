/**
 * The shared letter's player (`/letters/:id/player` and the share page): plays the letter's lines from
 * `lines.json` in order, each clip from `audio/:n`. No bed and no browser voice: a line whose clip fails is
 * shown as text for about as long as it would take to read, then skipped.
 */
type Line = { n: number; type: "dj" | "letter"; text: string };

/** How long a line without a clip stays on screen. */
export const readMs = (text: string): number => Math.max(2000, Array.from(text).length * 110);

/** The only base a player accepts: a shared letter's own path on this site. */
const BASE = /^\/letters\/[0-9a-f-]{36}$/;

export function mountEmbed(root: HTMLElement): void {
  const base = root.dataset.embed;
  if (!base || !BASE.test(base)) return;
  const button = root.querySelector<HTMLButtonElement>(".embed-toggle");
  const shown = root.querySelector<HTMLElement>(".embed-line");
  if (!button || !shown) return;
  const audio = new Audio();
  let lines: Line[] | null = null;
  let at = 0;
  let playing = false;
  /** A line is under way (its clip loaded, or its text on screen). */
  let current = false;
  let textOnly = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const label = () => {
    button.textContent = (playing ? root.dataset.pause : root.dataset.play) ?? "";
    button.setAttribute("aria-pressed", String(playing));
  };
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(next, readMs(lines?.[at]?.text ?? ""));
  };
  const skip = () => {
    if (textOnly || !current) return;
    textOnly = true;
    if (playing) wait();
  };
  const start = () => {
    const play = audio.play();
    play?.catch((e: unknown) => {
      // A pause before the clip began rejects with AbortError: that is not a missing clip.
      if ((e as { name?: string } | null)?.name !== "AbortError") skip();
    });
  };
  const begin = () => {
    clearTimeout(timer);
    textOnly = false;
    const line = lines?.[at];
    if (!line) {
      at = 0;
      current = playing = false;
      shown.textContent = "";
      label();
      return;
    }
    current = true;
    shown.textContent = line.text;
    audio.src = `${base}/audio/${line.n}`;
    start();
  };
  function next() {
    at++;
    begin();
  }

  // Fetched on mount, once: the first press must call `play()` inside the tap (iOS drops the gesture across an await).
  let waiting = false;
  void fetch(`${base}/lines.json`)
    .then(async (res) => (res.ok ? ((await res.json()) as { lines: Line[] }).lines : []))
    .catch(() => [])
    .then((got) => {
      lines = got;
      if (waiting && playing) begin();
      waiting = false;
    });

  audio.addEventListener("ended", next);
  audio.addEventListener("error", skip);
  button.addEventListener("click", () => {
    playing = !playing;
    label();
    if (!playing) {
      clearTimeout(timer);
      audio.pause();
      return;
    }
    if (!lines) {
      // Lines still on their way: play the element inside the tap so the browser lets it play later; the first line starts when they arrive.
      waiting = true;
      audio.play()?.catch(() => {});
      return;
    }
    if (!current) begin();
    else if (textOnly) wait();
    else start();
  });
}

for (const root of document.querySelectorAll<HTMLElement>("[data-embed]")) mountEmbed(root);
