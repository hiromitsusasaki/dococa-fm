import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetReportedListens } from "../../src/client/playback";
import { mountPlayer, type PlayerEpisode } from "../../src/client/player";

const strings: Record<string, string> = {
  "player.play": "再生",
  "player.pause": "一時停止",
  "player.next": "次の作品",
  "player.watashimo": "私も",
  "player.reply": "一言を送る",
  "player.send": "送る",
  "player.sent": "届けました",
  "player.foundSource": "ネットで見つけた声 — {author}（{site}）",
  "player.foundSourceNoSite": "ネットで見つけた声 — {author}",
  "player.sendFailed": "送れませんでした",
  "player.again": "この作品を聴く・観る",
  "player.put": "お便りを送る",
  "station.dial": "セレンディピティ",
  "station.failed": "電波が届きませんでした",
  "station.limit": "今日の分はここまで。また明日",
  "episode.continueOnStation": "あなたのラジオで続きを聴く",
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

let fetchMock: ReturnType<typeof vi.fn>;
let root: HTMLElement;

const respond = (status: number, body: unknown = {}) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => {
  localStorage.clear();
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
  forgetReportedListens();
  document.body.innerHTML = '<div id="player"></div>';
  root = document.getElementById("player")!;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const opts = (over: Record<string, unknown> = {}) => ({ voiceURI: "mine", ttsUrl: null, strings, ...over });
const btn = (action: string) => root.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
const tap = async (action: string) => {
  btn(action).click();
  await flush();
};

describe("player", () => {
  it("starts from the given segment, and ignores one out of range", async () => {
    mountPlayer(root, three, opts({ startSeg: 1 }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["b1", "c1", "c2"]));
    root.innerHTML = "";
    spoken.length = 0;
    mountPlayer(root, three, opts({ startSeg: 7 }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken[0]).toBe("a1"));
  });

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

  it("speaks dj and letter lines in order with the chosen voice", async () => {
    mountPlayer(root, one, opts());
    await tap("toggle");
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

  it("does not play a preview clip that an older episode still carries", async () => {
    const legacy: PlayerEpisode = { ...one, segments: [{ ...one.segments[0]!, lines: [{ type: "dj", text: "d1" }, { type: "preview", url: "https://p/a.mp3", seconds: 30 }, { type: "dj", text: "d2" }] }] };
    mountPlayer(root, legacy, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "d2"]));
    expect(audios.some((a) => a.src === "https://p/a.mp3")).toBe(false);
    expect(log).not.toContain("play:https://p/a.mp3");
  });

  it("reuses one clip element for every tts clip", async () => {
    mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    for (const src of ["/tts?episode=ep1&line=0", "/tts?episode=ep1&line=1"]) {
      await vi.waitFor(() => expect(audios.some((a) => a.src === src)).toBe(true));
      audios.find((a) => a.src === src)!.fire("ended");
    }
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=2")).toBe(true));
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

  it("asks for the next line's clip while the current one plays, once each", async () => {
    mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=0")).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/tts?episode=ep1&line=1");
    audios.find((a) => a.src === "/tts?episode=ep1&line=0")!.fire("ended");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=1")).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/tts?episode=ep1&line=2");
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
      originals: { L1: { main: "夜中にひとりで少し泣いた。", original: "Cried a little, alone at midnight." } },
      segments: [{ ...one.segments[0]!, lines: [letter("L1", "夜中にひとりで少し泣いた。")] }],
    };
    mountPlayer(root, translated, opts({ strings: { ...strings, "letter.showOriginal": "原文を見る" } }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["夜中にひとりで少し泣いた。"]));
    const quote = root.querySelector(".player-letter")!;
    expect(quote.textContent).toContain("夜中にひとりで少し泣いた。");
    const original = quote.querySelector("details.player-original")!;
    expect(original.querySelector("summary")!.textContent).toBe("原文を見る");
    expect(original.textContent).toContain("Cried a little, alone at midnight.");
  });

  it("shows the listener's-language text as the letter, keeping the spoken line unchanged", async () => {
    autoEnd = false;
    const translated: PlayerEpisode = {
      ...one,
      originals: { L1: { main: "Cried a little, alone at midnight.", original: "夜中にひとりで少し泣いた。" } },
      segments: [{ ...one.segments[0]!, lines: [letter("L1", "夜中にひとりで少し泣いた。")] }],
    };
    mountPlayer(root, translated, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["夜中にひとりで少し泣いた。"]));
    expect(root.querySelector(".player-letter > p")!.textContent).toBe("Cried a little, alone at midnight.");
    expect(root.querySelector(".player-original")!.textContent).toContain("夜中にひとりで少し泣いた。");
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

  it("plays the bed under dj and letter lines", async () => {
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1", "d2"]));
    const bed = audios.find((a) => a.src === "/bed.mp3")!;
    expect(bed.loop).toBe(true);
    expect(bed.volume).toBe(0.4);
    expect(log).toContain("play:/bed.mp3");
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

  it("after the last line, asks for no new episode and shows a link to keep listening on the listener's radio", async () => {
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(btn("continue")).not.toBeNull());
    expect(btn("continue").getAttribute("href")).toBe("/stations/mine");
    expect(btn("continue").textContent).toBe("あなたのラジオで続きを聴く");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(btn("toggle").textContent).toContain("再生");
  });

  it("never asks for a new episode while replaying, whatever segment plays", async () => {
    autoEnd = false;
    mountPlayer(root, three, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    await tap("next");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1"]));
    await tap("next");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1", "c1"]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(btn("continue")).toBeNull();
  });

  it("次の作品 on the last segment ends the replay with the link, without asking", async () => {
    autoEnd = false;
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["d1"]));
    await tap("next");
    await vi.waitFor(() => expect(btn("continue")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("plays again from the start after the end, and the link goes when it plays", async () => {
    mountPlayer(root, { ...one, segments: [{ ...one.segments[0]!, lines: [{ type: "dj", text: "only" }] }] }, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(btn("continue")).not.toBeNull());
    autoEnd = false;
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["only", "only"]));
    expect(btn("continue")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("plays dj and letter lines from ttsUrl as audio instead of speech", async () => {
    mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
    await tap("toggle");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=0")).toBe(true));
    expect(spoken).toEqual([]);
    audios.find((a) => a.src === "/tts?episode=ep1&line=0")!.fire("ended");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=1")).toBe(true));
    audios.find((a) => a.src === "/tts?episode=ep1&line=1")!.fire("ended");
    await vi.waitFor(() => expect(audios.some((a) => a.src === "/tts?episode=ep1&line=2")).toBe(true));
    expect(spoken).toEqual([]);
    // The engine is unlocked in the tap too, in case a cloud clip fails and the browser voice takes over.
    expect(unlockSpeaks).toBe(1);
  });

  describe("cloud clips that fail", () => {
    const clipAt = (line: number) => audios.find((a) => a.src === `/tts?episode=ep1&line=${line}`);
    const waitClip = (line: number) => vi.waitFor(() => expect(clipAt(line)).toBeDefined());

    it("asks again after 4 s, and plays the cloud clip when the second try works", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
      await tap("toggle");
      await waitClip(0);
      const plays = clipAt(0)!.play.mock.calls.length;
      clipAt(0)!.fire("error");
      await flush();
      vi.advanceTimersByTime(3900);
      await flush();
      expect(clipAt(0)!.play.mock.calls.length).toBe(plays);
      vi.advanceTimersByTime(200);
      await flush();
      expect(clipAt(0)!.play.mock.calls.length).toBe(plays + 1);
      expect(spoken).toEqual([]);
      clipAt(0)!.fire("ended");
      await waitClip(1);
      expect(spoken).toEqual([]);
    });

    it("reads only that line with the browser voice when the retry fails too, and tries the cloud again on the next line", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mountPlayer(root, one, opts({ ttsUrl: "/tts" }));
      await tap("toggle");
      await waitClip(0);
      clipAt(0)!.fire("error");
      await flush();
      vi.advanceTimersByTime(4000);
      await flush();
      clipAt(0)!.fire("error");
      await vi.waitFor(() => expect(spoken).toEqual(["d1"]));
      await waitClip(1);
      expect(clipAt(1)).toBeDefined();
    });

    it("gives up on the cloud for the rest of the episode after three lines in a row", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const four: PlayerEpisode = { ...one, segments: [{ itemId: "a", slot: "near", lines: [1, 2, 3, 4].map((n) => ({ type: "dj" as const, text: `x${n}` })) }] };
      mountPlayer(root, { ...four, id: "ep1" }, opts({ ttsUrl: "/tts" }));
      await tap("toggle");
      for (const line of [0, 1, 2]) {
        await waitClip(line);
        clipAt(line)!.fire("error");
        await flush();
        vi.advanceTimersByTime(4000);
        await flush();
        clipAt(line)!.fire("error");
        await vi.waitFor(() => expect(spoken.length).toBeGreaterThanOrEqual(line + 1));
      }
      await vi.waitFor(() => expect(spoken).toEqual(["x1", "x2", "x3", "x4"]));
      expect(clipAt(3)).toBeUndefined();
    });
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

  it("keeps the dial in this browser for the station, posting nothing when it turns or when the replay ends", async () => {
    mountPlayer(root, one, opts({ dial: 0.3 }));
    const dial = root.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(dial.value).toBe("0.3");
    dial.value = "0.7";
    dial.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(localStorage.getItem("dfm.dial")).toBe("0.7");
    await tap("toggle");
    await vi.waitFor(() => expect(btn("continue")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turning the knob while a segment plays asks for nothing", async () => {
    autoEnd = false;
    mountPlayer(root, three, opts({ dial: 0.3 }));
    await tap("toggle");
    await tap("next");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1"]));
    const dial = root.querySelector<HTMLInputElement>("input[type=range]")!;
    dial.value = "0.9";
    dial.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a knob turned back to the same value asks for nothing either, and the replay still ends with the link", async () => {
    mountPlayer(root, one, opts({ dial: 0.3 }));
    const dial = root.querySelector<HTMLInputElement>("input[type=range]")!;
    await tap("toggle");
    dial.value = "0.3";
    dial.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(btn("continue")).not.toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the link only once the last segment is done", async () => {
    autoEnd = false;
    mountPlayer(root, three, opts());
    await tap("toggle");
    await tap("next");
    await tap("next");
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1", "c1"]));
    expect(btn("continue")).toBeNull();
    speak.mock.calls.at(-1)![0].onend?.();
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "b1", "c1", "c2"]));
    expect(btn("continue")).toBeNull();
    speak.mock.calls.at(-1)![0].onend?.();
    await vi.waitFor(() => expect(btn("continue")).not.toBeNull());
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

describe("player: listens", () => {
  const listens = () => fetchMock.mock.calls.filter((c) => c[0] === "/listens");
  const mixed: PlayerEpisode = {
    id: "epM",
    items,
    segments: [
      { itemId: "a", slot: "near", lines: [{ type: "dj", text: "d1" }, letter("L1", "l1")] },
      { itemId: "b", slot: "far", lines: [{ ...letter("R1", "r1"), kind: "reply" as const }, letter("L2", "l2")] },
    ],
  };

  it("reports each letter once as it starts, with the segment index, but not a reply", async () => {
    mountPlayer(root, mixed, opts({ listensUrl: "/listens" }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1", "r1", "l2"]));
    expect(listens().map((c) => [c[1].method, c[1].headers["content-type"], JSON.parse(c[1].body)])).toEqual([
      ["POST", "application/json", { episodeId: "epM", letterId: "L1", segmentIndex: 0 }],
      ["POST", "application/json", { episodeId: "epM", letterId: "L2", segmentIndex: 1 }],
    ]);
  });

  it("does not report a letter again when the listener starts it over, and sends nothing without a url", async () => {
    mountPlayer(root, one, opts({ listensUrl: "/listens" }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken).toContain("l1"));
    root.innerHTML = "";
    mountPlayer(root, one, opts({ listensUrl: "/listens" }));
    await tap("toggle");
    await vi.waitFor(() => expect(spoken.filter((x) => x === "l1")).toHaveLength(2));
    expect(listens()).toHaveLength(1);
    forgetReportedListens();
    fetchMock.mockClear();
    root.innerHTML = "";
    mountPlayer(root, one, opts());
    await tap("toggle");
    await vi.waitFor(() => expect(spoken.filter((x) => x === "l1")).toHaveLength(3));
    expect(listens()).toHaveLength(0);
  });
});
