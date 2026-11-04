import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPlayer, type PlayerEpisode } from "../../src/client/player";

const strings: Record<string, string> = {
  "player.play": "再生",
  "player.pause": "一時停止",
  "player.next": "次の作品",
  "player.watashimo": "私も",
  "player.reply": "一言",
  "player.send": "送る",
  "player.sent": "届けました",
  "player.foundSource": "ネットで見つけた声 — {author}（{site}）",
  "player.foundSourceNoSite": "ネットで見つけた声 — {author}",
  "player.sendFailed": "送れませんでした",
  "player.again": "もう一度体験する",
  "player.put": "一通置く",
  "player.dial": "遠くのダイヤル",
  "player.loading": "読み込み中",
  "player.failed": "番組を作れませんでした",
  "player.limit": "今日の番組はここまで",
  "letter.who": "{name}さん",
  "letter.whoPlace": "{who}（{place}）",
  "listener.anonymous": "名無しのリスナー",
  "out.spotify": "Spotify で聴く",
};

const letter = (letterId: string, text: string) => ({
  type: "letter" as const,
  letterId,
  text,
  radioName: "しずく",
  place: "松本",
  kind: "letter" as const,
  sourceUrl: null,
  sourceAuthor: null,
});

const items = {
  a: { title: "曲A", creator: "作者A", imageUrl: "https://img/a.jpg", outLinks: { spotify: "https://open.spotify.com/a" } },
  b: { title: "曲B", creator: "作者B", imageUrl: null, outLinks: {} },
  c: { title: "曲C", creator: "作者C", imageUrl: null, outLinks: {} },
};

const one: PlayerEpisode = {
  id: "ep1",
  items,
  segments: [
    {
      itemId: "a",
      slot: "near",
      lines: [
        { type: "dj", text: "d1" },
        letter("L1", "l1"),
        { type: "preview", url: "https://p/a.mp3", seconds: 30 },
        { type: "dj", text: "d2" },
      ],
    },
  ],
};

const three: PlayerEpisode = {
  id: "ep3",
  items,
  segments: [
    { itemId: "a", slot: "near", lines: [{ type: "dj", text: "a1" }, { type: "dj", text: "a2" }] },
    { itemId: "b", slot: "neighbor", lines: [{ type: "dj", text: "b1" }] },
    { itemId: "c", slot: "far", lines: [{ type: "dj", text: "c1" }, { type: "dj", text: "c2" }] },
  ],
};

let log: string[];
let spoken: string[];
let audios: FakeAudio[];
let voices: object[];
let voiceListeners: Array<() => void>;
let autoEnd: boolean;
let unlockSpeaks: number;
let audioCtor: number;
let utterances: Array<{ text: string; lang: string; voice: unknown }>;

class FakeAudio {
  loop = false;
  volume = 1;
  paused = true;
  private handlers = new Map<string, Array<() => void>>();
  constructor(public src = "") {
    audios.push(this);
  }
  play = vi.fn(() => {
    this.paused = false;
    log.push(`play:${this.src}`);
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
    log.push(`pause:${this.src}`);
  });
  addEventListener(type: string, fn: () => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  fire(type: string) {
    for (const fn of this.handlers.get(type) ?? []) fn();
  }
}

class FakeUtterance {
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const speak = vi.fn((u: FakeUtterance) => {
  if (u.text === "") {
    unlockSpeaks++;
    return;
  }
  spoken.push(u.text);
  utterances.push({ text: u.text, lang: u.lang, voice: u.voice });
  if (autoEnd) queueMicrotask(() => u.onend?.());
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let navigate: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let root: HTMLElement;

const respond = (status: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  log = [];
  spoken = [];
  audios = [];
  utterances = [];
  voices = [{ voiceURI: "other", lang: "en-US" }, { voiceURI: "ja-1", lang: "ja-JP" }, { voiceURI: "mine", lang: "ja-JP" }];
  voiceListeners = [];
  autoEnd = true;
  unlockSpeaks = 0;
  audioCtor = 0;
  speak.mockClear();
  navigate = vi.fn();
  fetchMock = vi.fn(() => respond(200, { id: "next-ep" }));
  vi.stubGlobal("Audio", class extends FakeAudio { constructor(src?: string) { super(src); audioCtor++; } });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", {
    speak,
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: () => voices,
    addEventListener: (_t: string, fn: () => void) => voiceListeners.push(fn),
    removeEventListener: () => {},
  });
  vi.stubGlobal("fetch", fetchMock);
  document.body.innerHTML = '<div id="player"></div>';
  root = document.getElementById("player")!;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const opts = (over: Record<string, unknown> = {}) => ({ voiceURI: "mine", nextUrl: "/episodes/ep/next", ttsUrl: null, strings, navigate, ...over });
const btn = (action: string) => root.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
const tap = async (action: string) => {
  btn(action).click();
  await flush();
};

describe("player", () => {
  it("plays nothing until the listener taps play", async () => {
    mountPlayer(root, one, opts());
    await flush();
    expect(spoken).toEqual([]);
    expect(unlockSpeaks).toBe(0);
    expect(audios).toHaveLength(0);
    expect(btn("toggle").textContent).toContain("再生");
    expect(root.textContent).toContain("曲A");
    expect(root.textContent).toContain("作者A");
  });

  it("speaks dj and letter lines in order with the chosen voice, then previews, then the next dj", async () => {
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "https://p/a.mp3")).toBe(true));
    expect(spoken).toEqual(["d1", "l1"]);
    audios.find((a) => a.src === "https://p/a.mp3")!.fire("ended");
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1", "d2"]));
    expect(utterances.every((u) => u.lang === "ja-JP")).toBe(true);
    expect(utterances.every((u) => (u.voice as { voiceURI: string }).voiceURI === "mine")).toBe(true);
  });

  it("unlocks audio synchronously in the tap: speech engine and the shared clip element, before any await", () => {
    mountPlayer(root, one, opts());
    btn("toggle").click();
    expect(unlockSpeaks).toBe(1);
    const clip = audios.find((a) => a.src.startsWith("data:audio"))!;
    expect(clip.play).toHaveBeenCalledTimes(1);
    expect(audios.find((a) => a.src === "/bed.mp3")!.play).toHaveBeenCalled();
  });

  it("unlocks the bed inside the tap even when the first line is a preview", () => {
    const previewFirst: PlayerEpisode = { ...one, segments: [{ ...one.segments[0]!, lines: [{ type: "preview", url: "https://p/a.mp3", seconds: 30 }] }] };
    mountPlayer(root, previewFirst, opts());
    btn("toggle").click();
    const bed = audios.find((a) => a.src === "/bed.mp3")!;
    expect(bed.play).toHaveBeenCalledTimes(1);
    expect(bed.pause).toHaveBeenCalled();
    expect(bed.paused).toBe(true);
  });

  it("reuses one clip element for every preview and tts clip", async () => {
    mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    for (const src of ["/tts?episode=ep1&line=0", "/tts?episode=ep1&line=1", "https://p/a.mp3"]) {
      await vi.waitFor(() => expect(audios.some((a) => a.src === src)).toBe(true));
      audios.find((a) => a.src === src)!.fire("ended");
    }
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=3")).toBe(true));
    // one element for clips, one for the bed
    expect(audioCtor).toBe(2);
  });

  it("asks /tts for the stored line when the page left lines out", async () => {
    mountPlayer(root, { ...three, ttsLines: [0, 1, 4, 7, 8] }, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    for (const src of ["/tts?episode=ep3&line=0", "/tts?episode=ep3&line=1", "/tts?episode=ep3&line=4"]) {
      await vi.waitFor(() => expect(audios.some((a) => a.src === src)).toBe(true));
      audios.find((a) => a.src === src)!.fire("ended");
    }
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep3&line=7")).toBe(true));
  });

  it("asks for the next spoken line's clip while the current one plays, skipping previews, once each", async () => {
    mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=0")).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/tts?episode=ep1&line=1");
    audios.find((a) => a.src === "/tts?episode=ep1&line=0")!.fire("ended");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=1")).toBe(true));
    // Line 2 is a preview: the next spoken line is 3.
    expect(fetchMock).toHaveBeenCalledWith("/tts?episode=ep1&line=3");
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/tts?episode=ep1&line=1")).toHaveLength(1);
  });

  it("does not ask for clips when the episode has no cloud voice", async () => {
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0));
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/tts"))).toBe(false);
  });

  it("lets a reply be as long as the server allows", async () => {
    autoEnd = false;
    mountPlayer(root, { ...one, segments: [{ ...one.segments[0]!, lines: [letter("L1", "l1")] }] }, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["l1"]));
    await tap("reply");
    expect(root.querySelector("form.reply input")!.getAttribute("maxlength")).toBe("200");
  });

  it("falls back to the first ja voice when the saved voice is gone", async () => {
    mountPlayer(root, one, opts({ voiceURI: "missing" }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0));
    expect((utterances[0]!.voice as { voiceURI: string }).voiceURI).toBe("ja-1");
  });

  it("shows the letter text, radio name and place while it is read", async () => {
    autoEnd = false;
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["d1"]));
    speak.mock.calls.at(-1)![0].onend?.();
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1"]));
    expect(root.textContent).toContain("l1");
    expect(root.textContent).toContain("しずくさん（松本）");
  });

  it("shows the original under a translated letter, and reads only the translation", async () => {
    autoEnd = false;
    const translated: PlayerEpisode = {
      ...one,
      originals: { L1: { body: "Cried a little, alone at midnight.", lang: "en" } },
      segments: [{ ...one.segments[0]!, lines: [letter("L1", "夜中にひとりで少し泣いた。")] }],
    };
    mountPlayer(root, translated, opts({ strings: { ...strings, "player.original": "原文" } }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["夜中にひとりで少し泣いた。"]));
    const quote = root.querySelector(".player-letter")!;
    expect(quote.textContent).toContain("夜中にひとりで少し泣いた。");
    const original = quote.querySelector(".player-original")!;
    expect(original.textContent).toContain("原文");
    expect(original.textContent).toContain("Cried a little, alone at midnight.");
    expect(original.getAttribute("lang")).toBe("en");
  });

  it("shows no original line for a letter written in Japanese", async () => {
    autoEnd = false;
    mountPlayer(root, { ...one, segments: [{ ...one.segments[0]!, lines: [letter("L1", "l1")] }] }, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["l1"]));
    expect(root.querySelector(".player-original")).toBeNull();
  });

  it("shows a found voice with its source as a link and marks the card", async () => {
    autoEnd = false;
    const found: PlayerEpisode = {
      ...one,
      segments: [{ ...one.segments[0]!, lines: [{ ...letter("F1", "ネットの声"), kind: "found", sourceUrl: "https://www.example.com/c/1", sourceAuthor: "taro" }] }],
    };
    mountPlayer(root, found, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["ネットの声"]));
    const a = root.querySelector<HTMLAnchorElement>(".player-letter.found a")!;
    expect(a.getAttribute("href")).toBe("https://www.example.com/c/1");
    expect(a.textContent).toBe("ネットで見つけた声 — taro（example.com）");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("omits the site parentheses when the source url has no host", async () => {
    autoEnd = false;
    const found: PlayerEpisode = {
      ...one,
      segments: [{ ...one.segments[0]!, lines: [{ ...letter("F1", "x"), kind: "found", sourceUrl: "https://", sourceAuthor: "taro" }] }],
    };
    mountPlayer(root, found, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["x"]));
    expect(root.querySelector(".player-letter.found")!.textContent).toContain("ネットで見つけた声 — taro");
    expect(root.querySelector(".player-letter.found")!.textContent).not.toContain("（");
  });

  it("plays a preview with Audio and stops the bed for it; the bed plays only under dj and letter lines", async () => {
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(log).toContain("play:https://p/a.mp3"));
    const bed = audios.find((a) => a.src === "/bed.mp3")!;
    expect(bed.loop).toBe(true);
    expect(bed.volume).toBe(0.15);
    expect(log.indexOf("play:/bed.mp3")).toBeLessThan(log.indexOf("pause:/bed.mp3"));
    expect(log.indexOf("pause:/bed.mp3")).toBeLessThan(log.indexOf("play:https://p/a.mp3"));
    audios.find((a) => a.src === "https://p/a.mp3")!.fire("ended");
    await vi.waitFor(() => expect(log.lastIndexOf("play:/bed.mp3")).toBeGreaterThan(log.indexOf("play:https://p/a.mp3")));
  });

  it("ends a preview after its seconds even when the file keeps going", async () => {
    vi.useFakeTimers();
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.advanceTimersByTimeAsync(0);
    const preview = audios.find((a) => a.src === "https://p/a.mp3")!;
    expect(preview.paused).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(spoken).toEqual(["d1", "l1"]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(preview.paused).toBe(true);
    expect(spoken).toEqual(["d1", "l1", "d2"]);
  });

  it("player_waits_for_voices: waits for voiceschanged when no voices are loaded yet", async () => {
    voices = [];
    mountPlayer(root, one, opts());
    await tap("toggle");
    await flush();
    expect(spoken).toEqual([]);
    voices = [{ voiceURI: "mine", lang: "ja-JP" }];
    for (const fn of voiceListeners) fn();
    await vi.waitFor(() => expect(speak).toHaveBeenCalled());
    expect((utterances[0]!.voice as { voiceURI: string }).voiceURI).toBe("mine");
  });

  it("player_waits_for_voices: continues with the default voice after 2 seconds", async () => {
    vi.useFakeTimers();
    voices = [];
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.advanceTimersByTimeAsync(1_900);
    expect(spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(spoken.length).toBeGreaterThan(0);
    expect(utterances[0]!.voice).toBeFalsy();
  });

  it("after the last line, posts to nextUrl once and goes to the new episode", async () => {
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(log).toContain("play:https://p/a.mp3"));
    audios.find((a) => a.src === "https://p/a.mp3")!.fire("ended");
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/episodes/next-ep"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/episodes/ep/next", { method: "POST" });
  });

  it("starts the next episode when the second-to-last segment begins, not earlier", async () => {
    autoEnd = false;
    mountPlayer(root, three, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    expect(fetchMock).not.toHaveBeenCalled();
    await tap("next");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tap("next");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1", "c1"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows the limit message and stops on 429", async () => {
    fetchMock.mockImplementation(() => respond(429, { error: "limit" }));
    mountPlayer(root, { ...one, segments: [{ ...one.segments[0]!, lines: [{ type: "dj", text: "only" }] }] }, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(root.textContent).toContain("今日の番組はここまで"));
    expect(navigate).not.toHaveBeenCalled();
    expect(btn("toggle").textContent).toContain("再生");
  });

  it("shows the failure message on 503", async () => {
    fetchMock.mockImplementation(() => respond(503, { error: "unavailable" }));
    mountPlayer(root, { ...one, segments: [{ ...one.segments[0]!, lines: [{ type: "dj", text: "only" }] }] }, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(root.textContent).toContain("番組を作れませんでした"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("plays dj and letter lines from ttsUrl as audio instead of speech", async () => {
    mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=0")).toBe(true));
    expect(spoken).toEqual([]);
    audios.find((a) => a.src === "/tts?episode=ep1&line=0")!.fire("ended");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=1")).toBe(true));
    audios.find((a) => a.src === "/tts?episode=ep1&line=1")!.fire("ended");
    await vi.waitFor(() => expect(log).toContain("play:https://p/a.mp3"));
    audios.find((a) => a.src === "https://p/a.mp3")!.fire("ended");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=3")).toBe(true));
    expect(spoken).toEqual([]);
    // The engine is unlocked in the tap too, in case a cloud clip fails and the browser voice takes over.
    expect(unlockSpeaks).toBe(1);
  });

  it("falls back to speech for a tts line whose clip fails, and stays on speech afterwards", async () => {
    mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=0")).toBe(true));
    audios.find((a) => a.src === "/tts?episode=ep1&line=0")!.fire("error");
    await vi.waitFor(() => expect(spoken.slice(0, 2)).toEqual(["d1", "l1"]));
    expect(audios.some((a) => a.src === "/tts?episode=ep1&line=1")).toBe(false);
  });

  it("次の作品 skips to the next segment", async () => {
    autoEnd = false;
    mountPlayer(root, three, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    await tap("next");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1"]));
    expect(root.textContent).toContain("曲B");
  });

  it("pauses and resumes the current line", async () => {
    autoEnd = false;
    mountPlayer(root, three, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    await tap("toggle");
    expect(btn("toggle").textContent).toContain("再生");
    expect((speechSynthesis.cancel as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(audios.find((a) => a.src === "/bed.mp3")!.paused).toBe(true);
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "a1"]));
    expect(btn("toggle").textContent).toContain("一時停止");
  });

  it("lists the item's outlinks and a link to put a letter", async () => {
    mountPlayer(root, one, opts());
    await flush();
    const again = [...root.querySelectorAll<HTMLAnchorElement>('[data-action="again"] a')];
    expect(again.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Spotify で聴く", "https://open.spotify.com/a"]]);
    expect(btn("put").getAttribute("href")).toBe("/put?itemId=a");
  });

  it("私も posts a watashimo reaction to the current letter", async () => {
    autoEnd = false;
    mountPlayer(root, one, opts());
    expect(btn("watashimo")).toBeNull();
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["d1"]));
    speak.mock.calls.at(-1)![0].onend?.();
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1"]));
    fetchMock.mockClear();
    fetchMock.mockImplementation(() => respond(200));
    await tap("watashimo");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/letters");
    expect(init.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "watashimo", itemId: "a", parentLetterId: "L1" });
    await vi.waitFor(() => expect(btn("watashimo").textContent).toContain("届けました"));
  });

  it("一言 reveals a one-line form that posts kind=reply", async () => {
    autoEnd = false;
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["d1"]));
    speak.mock.calls.at(-1)![0].onend?.();
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1"]));
    expect(root.querySelector("form.reply")).toBeNull();
    await tap("reply");
    const input = root.querySelector<HTMLInputElement>("form.reply input[type=text]")!;
    input.value = "いい曲";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    fetchMock.mockClear();
    fetchMock.mockImplementation(() => respond(200));
    root.querySelector<HTMLFormElement>("form.reply")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/letters");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "reply", body: "いい曲", itemId: "a", parentLetterId: "L1" });
  });

  it("posts the dial to /settings/dial when it changes", async () => {
    mountPlayer(root, one, opts({ dial: 0.3 }));
    const dial = root.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(dial.value).toBe("0.3");
    dial.value = "0.7";
    dial.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/settings/dial");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
    expect(String(init.body)).toBe("dial=0.7");
  });

  it("registers media session metadata and handlers when available", async () => {
    const handlers: Record<string, () => void> = {};
    const mediaSession = { metadata: null as unknown, playbackState: "none", setActionHandler: (a: string, fn: () => void) => (handlers[a] = fn) };
    vi.stubGlobal("MediaMetadata", class { constructor(public init: object) {} });
    vi.stubGlobal("navigator", { mediaSession });
    autoEnd = false;
    mountPlayer(root, three, opts());
    expect(Object.keys(handlers).sort()).toEqual(["nexttrack", "pause", "play"]);
    handlers.play!();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    expect((mediaSession.metadata as { init: { title: string; artist: string } }).init).toMatchObject({ title: "曲A", artist: "作者A" });
    handlers.nexttrack!();
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1"]));
    expect((mediaSession.metadata as { init: { title: string } }).init.title).toBe("曲B");
    handlers.pause!();
    await flush();
    expect(btn("toggle").textContent).toContain("再生");
  });
});
