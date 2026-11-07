import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountEmbed, readMs } from "../../src/client/embed";

const LINES = [
  { n: 0, type: "dj", text: "Blue in Green という曲の紹介です。" },
  { n: 2, type: "dj", text: "しずくさんからのお便りです。" },
  { n: 3, type: "letter", text: "夜の帰り道に聴きます。" },
];

let audios: HTMLAudioElement[] = [];
let play: ReturnType<typeof vi.fn>;

function mount() {
  document.body.innerHTML = `
    <section class="embed-player" data-embed="/letters/abc" data-play="再生" data-pause="一時停止">
      <p class="embed-line"></p>
      <button type="button" class="embed-toggle" aria-pressed="false">再生</button>
    </section>`;
  const root = document.querySelector<HTMLElement>("[data-embed]")!;
  mountEmbed(root);
  return { button: root.querySelector<HTMLButtonElement>(".embed-toggle")!, line: root.querySelector<HTMLElement>(".embed-line")! };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const audio = () => audios[0]!;

beforeEach(() => {
  vi.useFakeTimers();
  audios = [];
  const Real = window.Audio;
  vi.stubGlobal(
    "Audio",
    function (this: unknown) {
      const a = new Real();
      audios.push(a);
      return a;
    } as unknown as typeof Audio,
  );
  play = vi.fn(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as () => Promise<void>);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ lines: LINES }), { headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the shared letter's player", () => {
  it("fetches the lines on the first press and plays each clip in order, showing its text", async () => {
    const { button, line } = mount();
    expect(fetch).not.toHaveBeenCalled();
    button.click();
    await flush();
    expect(fetch).toHaveBeenCalledWith("/letters/abc/lines.json");
    expect(audio().src).toMatch(/\/letters\/abc\/audio\/0$/);
    expect(line.textContent).toBe(LINES[0]!.text);
    expect(button.textContent).toBe("一時停止");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    audio().dispatchEvent(new Event("ended"));
    expect(audio().src).toMatch(/\/audio\/2$/);
    expect(line.textContent).toBe(LINES[1]!.text);
    audio().dispatchEvent(new Event("ended"));
    expect(audio().src).toMatch(/\/audio\/3$/);
    audio().dispatchEvent(new Event("ended"));
    // The end: back to the start, ready to play again.
    expect(button.textContent).toBe("再生");
    expect(line.textContent).toBe("");
  });

  it("shows a line without a clip as text for its reading time, then goes on", async () => {
    const { button, line } = mount();
    button.click();
    await flush();
    audio().dispatchEvent(new Event("error"));
    expect(line.textContent).toBe(LINES[0]!.text);
    vi.advanceTimersByTime(readMs(LINES[0]!.text) - 1);
    expect(audio().src).toMatch(/\/audio\/0$/);
    vi.advanceTimersByTime(1);
    expect(audio().src).toMatch(/\/audio\/2$/);
  });

  it("treats a refused play as a missing clip, but not a pause before the clip began", async () => {
    play.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    const { button } = mount();
    button.click();
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(audio().src).toMatch(/\/audio\/0$/);

    play.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("denied"), { name: "NotSupportedError" })));
    audio().dispatchEvent(new Event("ended"));
    await flush();
    vi.advanceTimersByTime(readMs(LINES[1]!.text));
    expect(audio().src).toMatch(/\/audio\/3$/);
  });

  it("pauses and resumes the same line", async () => {
    const { button } = mount();
    button.click();
    await flush();
    button.click();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(button.textContent).toBe("再生");
    button.click();
    expect(play).toHaveBeenCalledTimes(2);
    expect(audio().src).toMatch(/\/audio\/0$/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a paused text-only line on screen until play is pressed again", async () => {
    const { button } = mount();
    button.click();
    await flush();
    audio().dispatchEvent(new Event("error"));
    button.click();
    vi.advanceTimersByTime(60_000);
    expect(audio().src).toMatch(/\/audio\/0$/);
    button.click();
    vi.advanceTimersByTime(readMs(LINES[0]!.text));
    expect(audio().src).toMatch(/\/audio\/2$/);
  });
});
