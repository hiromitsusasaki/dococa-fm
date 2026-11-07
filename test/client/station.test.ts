import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetReportedListens, resumeAt } from "../../src/client/playback";
import { mountStation, type StationOptions } from "../../src/client/station";

const strings: Record<string, string> = {
  "station.onOff": "ラジオをつける / 止める",
  "station.on": "ラジオをつける",
  "station.off": "止める",
  "station.growStart": "好きなものを 3 つ送る",
  "station.onAir": "ON AIR",
  "station.volume": "音量",
  "station.dial": "セレンディピティ",
  "station.nowPlaying": "いま流れている",
  "station.panel": "オンエア",
  "station.now": "いま",
  "station.next": "このあと",
  "station.offHint": "スイッチを入れると、ここにお便りが並びます。",
  "station.tuning": "チューニング中",
  "station.limit": "今日の分はここまで。また明日",
  "station.failed": "電波が届きませんでした",
  "station.empty": "まだお便りがありません",
  "station.grow": "あなたのラジオ",
  "station.growHelp": "好きなものを 3 つ送ると始まります",
  "player.watashimo": "私も",
  "player.reply": "一言を送る",
  "player.send": "送る",
  "player.sent": "届けました",
  "player.replyLabel": "一言",
  "player.again": "この作品を聴く・観る",
  "player.sendFailed": "送れませんでした",
  "letter.showOriginal": "原文を見る",
  "letter.who": "{name}さん",
  "letter.whoPlace": "{who}（{place}）",
  "listener.anonymous": "名無しのリスナー",
  "kind.music": "音楽",
  "kind.film": "映画",
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
  a: { title: "曲A", creator: "作者A", imageUrl: "https://img/a.jpg", outLinks: { spotify: "https://open.spotify.com/a" }, kind: "music", year: 1999 },
  b: { title: "曲B", creator: "作者B", imageUrl: null, outLinks: {}, kind: "film", year: null },
  c: { title: "曲C", creator: "作者C", imageUrl: null, outLinks: {}, kind: "music", year: 2001 },
};

const view = (id: string, segs: Array<[string, Array<Record<string, unknown>>]>, originals = {}) => ({
  id,
  items,
  originals,
  ttsLines: [] as number[],
  cloudTts: false,
  segments: segs.map(([itemId, lines]) => ({ itemId, slot: "far", lines })),
});
const dj = (text: string) => ({ type: "dj", text });

/** Three segments, so the next episode is asked for while the second plays. */
const epA = () => view("epA", [["a", [dj("a1"), letter("L1", "l1")]], ["b", [dj("b1")]], ["c", [dj("c1")]]]);
const epB = () => view("epB", [["a", [dj("x1")]], ["b", [dj("x2")]]]);

class FakeAudio {
  loop = false;
  volume = 1;
  paused = true;
  constructor(public src = "") {
    audios.push(this);
  }
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  addEventListener() {}
  removeEventListener() {}
}
class FakeUtterance {
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

let audios: FakeAudio[];
let spoken: string[];
let held: Array<{ onend: (() => void) | null }>;
let autoEnd: boolean;
let calls: string[];
/** The JSON bodies sent to the next url, in order. */
let bodies: Array<Record<string, unknown>>;
let nextReplies: Array<() => Promise<Response>>;
let resumeReply: () => Promise<Response>;
let resumeByIdReply: (url: string) => Promise<Response>;
let root: HTMLElement;

const json = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const ok = (v: object) => json(200, { episode: v, station: { key: "world", label: "Dococa FM" } });
const none = () => Promise.resolve(new Response(null, { status: 204 }));

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  audios = [];
  spoken = [];
  held = [];
  autoEnd = true;
  calls = [];
  bodies = [];
  nextReplies = [];
  resumeReply = none;
  resumeByIdReply = none;
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("speechSynthesis", {
    speak: (u: FakeUtterance) => {
      if (u.text === "") return;
      spoken.push(u.text);
      held.push(u);
      if (autoEnd) queueMicrotask(() => u.onend?.());
    },
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: () => [{ voiceURI: "mine", lang: "ja-JP" }],
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/stations/world.json") return resumeReply();
      if (url.startsWith("/stations/world.json?id=")) return resumeByIdReply(url);
      if (url === "/stations/world/next") {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return (nextReplies.shift() ?? json(503, { error: "unavailable" }))();
      }
      return json(200, {})();
    }),
  );
  localStorage.clear();
  forgetReportedListens();
  document.body.innerHTML = '<div id="station"></div>';
  root = document.getElementById("station")!;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const opts = (over: Partial<StationOptions> = {}): StationOptions => ({
  stationKey: "world",
  label: "Dococa FM",
  nextUrl: "/stations/world/next",
  resumeUrl: "/stations/world.json",
  ttsUrl: null,
  voiceURI: "mine",
  strings,
  ...over,
});
const el = (action: string) => root.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
const power = async () => {
  el("power").click();
  await flush();
};
const posts = () => calls.filter((c) => c.startsWith("POST /stations/world/next")).length;

describe("station: screen", () => {
  it("starts off: a labelled switch, a volume, no dial for world, nothing fetched or played", async () => {
    const s = mountStation(root, opts());
    await flush();
    expect(s.state().power).toBe("off");
    expect(el("power").tagName).toBe("BUTTON");
    expect(el("power").getAttribute("aria-pressed")).toBe("false");
    expect(root.textContent).toContain("ラジオをつける");
    expect(el("power").getAttribute("aria-label")).toBe("ラジオをつける / 止める");
    expect(root.textContent).toContain("DOCOCA FM");
    expect(root.querySelector(".live")).toBeNull();
    expect(root.querySelector('input[type=range][data-action="volume"]')).not.toBeNull();
    expect(el("dial")).toBeNull();
    expect(calls).toEqual([]);
    expect(audios).toHaveLength(0);
  });

  it("shows the dial on a station that has one, with the saved value", async () => {
    mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    await flush();
    expect((el("dial") as HTMLInputElement).value).toBe("0.4");
    expect(root.textContent).toContain("セレンディピティ");
  });

  it("a station with no history shows the way to start and a switch that is not usable", async () => {
    mountStation(root, opts({ stationKey: "mine", grow: true }));
    await flush();
    expect(root.querySelector(".grow a")!.getAttribute("href")).toBe("/start");
    expect(root.querySelector(".grow a")!.textContent).toBe("好きなものを 3 つ送る");
    expect(root.querySelector(".grow")!.textContent).toContain("好きなものを 3 つ送ると始まります");
    expect((el("power") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("station: playing", () => {
  it("resumes the latest episode when the server has one, without making a new one", async () => {
    resumeReply = ok(epB());
    const s = mountStation(root, opts());
    await power();
    expect(calls[0]).toBe("GET /stations/world.json");
    expect(s.state().current?.id).toBe("epB");
    await vi.waitFor(() => expect(spoken).toContain("x1"));
  });

  describe("where you left off", () => {
    const store = (episodeId: string, seg: number, line: number) => localStorage.setItem("dfm.pos:world", JSON.stringify({ episodeId, seg, line }));

    it("keeps the position of the episode being played, per station", async () => {
      nextReplies = [ok(epA()), ok(epB())];
      autoEnd = false;
      mountStation(root, opts());
      await power();
      await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
      held[0]!.onend?.();
      await vi.waitFor(() => expect(spoken).toEqual(["a1", "l1"]));
      expect(JSON.parse(localStorage.getItem("dfm.pos:world")!)).toEqual({ episodeId: "epA", seg: 0, line: 1, letterId: "L1" });
      expect(localStorage.getItem("dfm.pos:mine")).toBeNull();
    });

    it("asks for the stored episode by id and picks up at its segment and line, not at the latest", async () => {
      store("epA", 1, 0);
      resumeByIdReply = ok(epA());
      resumeReply = ok(epB());
      const s = mountStation(root, opts());
      await power();
      expect(calls[0]).toBe("GET /stations/world.json?id=epA");
      expect(calls).not.toContain("GET /stations/world.json");
      expect(s.state().current?.id).toBe("epA");
      await vi.waitFor(() => expect(spoken[0]).toBe("b1"));
      expect(spoken).not.toContain("a1");
    });

    it("resumes at the segment that now reads the stored letter when an earlier one was taken down", async () => {
      // Stored while segment 1 (曲B, letter L2) played; the view now lacks segment 0, so L2 is in segment 0.
      localStorage.setItem("dfm.pos:world", JSON.stringify({ episodeId: "epT", seg: 1, line: 1, letterId: "L2" }));
      resumeByIdReply = ok(view("epT", [["b", [dj("b1"), letter("L2", "l2")]], ["c", [dj("c1")]]]));
      const s = mountStation(root, opts());
      await power();
      expect(s.state().current?.id).toBe("epT");
      // The index rule alone would start at segment 1 line 1, which does not exist here, and read c1 first.
      await vi.waitFor(() => expect(spoken.slice(0, 2)).toEqual(["b1", "l2"]));
    });

    it("falls back to the latest episode when the stored one is not found", async () => {
      store("gone", 1, 0);
      resumeByIdReply = none;
      resumeReply = ok(epB());
      const s = mountStation(root, opts());
      await power();
      expect(calls.slice(0, 2)).toEqual(["GET /stations/world.json?id=gone", "GET /stations/world.json"]);
      expect(s.state().current?.id).toBe("epB");
      await vi.waitFor(() => expect(spoken).toContain("x1"));
    });

    it("starts the line again when the stored position is out of range", async () => {
      store("epA", 0, 9);
      resumeByIdReply = ok(epA());
      mountStation(root, opts());
      await power();
      await vi.waitFor(() => expect(spoken[0]).toBe("a1"));
    });

    it("does not replay an episode that was played to its end: it takes a later one, or makes a new one", async () => {
      store("epB", 1, 1);
      resumeByIdReply = ok(epB());
      resumeReply = ok(epB());
      nextReplies = [ok(epA())];
      autoEnd = false;
      const s = mountStation(root, opts());
      await power();
      expect(s.state().current?.id).toBe("epA");
      expect(posts()).toBe(1);
      await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    });

    it("takes the episode that was made ahead when the stored one was played to its end", async () => {
      store("epA", 2, 1);
      resumeByIdReply = ok(epA());
      resumeReply = ok(epB());
      const s = mountStation(root, opts());
      await power();
      expect(s.state().current?.id).toBe("epB");
      expect(calls).toContain("GET /stations/world.json");
    });
  });

  it("makes an episode with POST when there is nothing to resume, then reads it and shows ON AIR", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    const s = mountStation(root, opts());
    await power();
    expect(calls.slice(0, 2)).toEqual(["GET /stations/world.json", "POST /stations/world/next"]);
    expect(s.state().power).toBe("on");
    expect(s.state().current?.id).toBe("epA");
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    expect(el("power").getAttribute("aria-pressed")).toBe("true");
    expect(root.textContent).toContain("止める");
    expect(root.querySelector(".live")?.textContent).toBe("ON AIR");
    expect(root.querySelector(".now")!.textContent).toContain("曲A");
    expect(root.querySelector(".now")!.textContent).toContain("作者A");
  });

  it("goes on to the next episode by itself", async () => {
    nextReplies = [ok(epA()), ok(epB()), ok(view("epC", [["c", [dj("z1")]]]))];
    const s = mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toContain("z1"));
    expect(spoken.slice(0, 7)).toEqual(["a1", "l1", "b1", "c1", "x1", "x2", "z1"]);
    expect(s.state().current?.id).toBe("epC");
  });

  it("asks for one more episode when two segments are left, and no more until it is used", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    const s = mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    expect(posts()).toBe(1);
    const end = async (n: number) => {
      held[n]!.onend?.();
      await flush();
    };
    await end(0);
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "l1"]));
    await end(1);
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "l1", "b1"]));
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["epB"]));
    await end(2);
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "l1", "b1", "c1"]));
    expect(posts()).toBe(2);
    expect(s.state().current?.id).toBe("epA");
  });

  it("lists the letter on air first, then what is still to come, with kind, title and creator but no numbers", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    const items = [...root.querySelectorAll(".up-next li")];
    const rows = items.map((li) => li.textContent);
    expect(root.querySelector(".side h2")!.textContent).toBe("オンエア");
    expect(items[0]!.classList.contains("now")).toBe(true);
    expect(items[0]!.querySelector(".tag")!.textContent).toBe("いま");
    expect(rows[0]).toContain("曲A");
    expect(items[1]!.classList.contains("now")).toBe(false);
    expect(items[1]!.querySelector(".tag")!.textContent).toBe("このあと");
    expect(rows[1]).toContain("映画");
    expect(rows[1]).toContain("曲B");
    expect(rows[1]).toContain("作者B");
    expect(rows.join(" ")).not.toMatch(/\d/);
    expect(root.querySelector("ol")).toBeNull();
  });

  it("names the sender of the next letter in the list, and only for a work that has one", async () => {
    const ep = view("epS", [["a", [dj("a1")]], ["b", [dj("b1"), letter("L2", "こんにちは")]], ["c", [dj("c1")]]]);
    nextReplies = [ok(ep), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    const rows = [...root.querySelectorAll(".up-next li")];
    expect(rows[0]!.querySelector(".sender")).toBeNull();
    expect(rows[1]!.textContent).toContain("曲B");
    expect(rows[1]!.querySelector(".sender")?.textContent).toBe("しずくさん（松本）");
    expect(rows[2]!.textContent).toContain("曲C");
    expect(rows[2]!.querySelector(".sender")).toBeNull();
  });

  it("shows the sender's place from the codes in the page's language", async () => {
    const en = { ...strings, "lang.code": "en", "letter.who": "{name}", "letter.whoPlace": "{who} ({place})" };
    const ep = view("epP", [["a", [{ ...letter("L8", "Hello"), placeCountry: "JP", placeRegion: "32" }]]], { L8: { main: "Hello", original: null } });
    nextReplies = [ok(ep)];
    autoEnd = false;
    mountStation(root, opts({ strings: en }));
    await power();
    await vi.waitFor(() => expect(root.querySelector("blockquote.player-letter")).not.toBeNull());
    expect(root.querySelector("blockquote.player-letter")!.textContent).toContain("しずく (Shimane, Japan)");
  });

  it("shows the letter being read with its sender and a toggle for the original", async () => {
    const ep = view("epL", [["a", [{ ...letter("L9", "こんにちは") }]]], { L9: { main: "こんにちは", original: "Hello" } });
    nextReplies = [ok(ep)];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(root.querySelector("blockquote.player-letter")).not.toBeNull());
    const q = root.querySelector("blockquote.player-letter")!;
    expect(q.textContent).toContain("こんにちは");
    expect(q.textContent).toContain("しずくさん（松本）");
    expect(q.querySelector("details summary")!.textContent).toBe("原文を見る");
    expect(root.querySelector(".react")).not.toBeNull();
  });

  it("OFF stops the sound and keeps the place; ON reads the same line again", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    const s = mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    const before = { seg: s.state().seg, line: s.state().line };
    await power();
    expect(s.state().power).toBe("off");
    expect(el("power").getAttribute("aria-pressed")).toBe("false");
    expect(root.querySelector(".live")).toBeNull();
    expect(s.state().current?.id).toBe("epA");
    expect({ seg: s.state().seg, line: s.state().line }).toEqual(before);
    await power();
    expect(s.state().power).toBe("on");
    expect(posts()).toBe(1);
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "a1"]));
  });
});

describe("station: switching during the hand-over", () => {
  it("OFF while the next episode is awaited, then ON, does not read the last line again", async () => {
    let release!: () => void;
    const slow = () => new Promise<Response>((r) => (release = () => r(new Response(JSON.stringify({ episode: epB() }), { status: 200 }))));
    const one = view("epOne", [["a", [dj("only")]]]);
    nextReplies = [ok(one), slow];
    const s = mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(s.state().loading ?? true).toBeTruthy());
    await vi.waitFor(() => expect(spoken).toEqual(["only"]));
    await vi.waitFor(() => expect(typeof release).toBe("function"));
    await flush();
    await power();
    expect(s.state().power).toBe("off");
    release();
    await flush();
    await power();
    await vi.waitFor(() => expect(spoken).toContain("x1"));
    expect(spoken.filter((t) => t === "only")).toHaveLength(1);
  });

  it("shows no exit block for a work without links", async () => {
    nextReplies = [ok(view("epN", [["b", [dj("n1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["n1"]));
    expect(root.querySelector('[data-action="again"]')).toBeNull();
  });
});

describe("station: failures", () => {
  it("429 on the first episode: power is limit and the limit message shows", async () => {
    nextReplies = [json(429, { error: "limit" })];
    const s = mountStation(root, opts());
    await power();
    expect(s.state().power).toBe("limit");
    expect(root.textContent).toContain("今日の分はここまで。また明日");
    expect(el("power").getAttribute("aria-pressed")).toBe("false");
    expect(spoken).toEqual([]);
  });

  it("429 while asking ahead: the current episode is finished first, then power is limit", async () => {
    nextReplies = [ok(epA()), json(429, { error: "limit" })];
    const s = mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(s.state().power).toBe("limit"));
    expect(spoken).toEqual(["a1", "l1", "b1", "c1"]);
    expect(root.textContent).toContain("今日の分はここまで。また明日");
    expect(posts()).toBe(2);
  });

  it("any other failure: power is failed with the failure message", async () => {
    nextReplies = [json(503, { error: "unavailable" })];
    const s = mountStation(root, opts());
    await power();
    expect(s.state().power).toBe("failed");
    expect(root.textContent).toContain("電波が届きませんでした");
  });

  it("a network error is a failure too", async () => {
    nextReplies = [() => Promise.reject(new TypeError("offline"))];
    const s = mountStation(root, opts());
    await power();
    expect(s.state().power).toBe("failed");
  });

  it("409 empty says there are no letters yet", async () => {
    nextReplies = [json(409, { error: "empty" })];
    const s = mountStation(root, opts());
    await power();
    expect(s.state().power).toBe("failed");
    expect(root.textContent).toContain("まだお便りがありません");
  });

  it("after a failure the switch tries again", async () => {
    nextReplies = [json(503, {}), ok(epB())];
    const s = mountStation(root, opts());
    await power();
    expect(s.state().power).toBe("failed");
    await power();
    await vi.waitFor(() => expect(spoken).toContain("x1"));
    expect(s.state().current?.id).toBe("epB");
  });
});

describe("station: retro controls", () => {
  const needle = (sel: string) => root.querySelector<HTMLElement>(`${sel} .knob-body`)!.style.getPropertyValue("--angle");

  it("ON lights the switch and shows ON AIR on the dial face; OFF hides it", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    expect(root.querySelector('button.switch[aria-pressed="true"]')).not.toBeNull();
    expect(root.querySelector(".face .live")).not.toBeNull();
    expect(root.querySelector(".scale.sweep")).not.toBeNull();
    await power();
    expect(root.querySelector(".scale.sweep")).toBeNull();
    expect(root.querySelector(".face .live")).toBeNull();
  });

  it("the volume needle follows the range", async () => {
    mountStation(root, opts());
    await flush();
    expect(needle(".knob-volume")).toBe("81deg");
    const input = root.querySelector<HTMLInputElement>('input[data-action="volume"]')!;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect(needle(".knob-volume")).toBe("-135deg");
  });

  it("the dial needle follows the range", async () => {
    mountStation(root, opts({ stationKey: "mine", dial: 0.5 }));
    await flush();
    expect(needle(".knob-dial")).toBe("0deg");
    const input = el("dial") as HTMLInputElement;
    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(needle(".knob-dial")).toBe("135deg");
  });

  it("world has no dial knob", async () => {
    mountStation(root, opts());
    await flush();
    expect(root.querySelector(".knob-dial")).toBeNull();
  });
});

describe("station: volume", () => {
  const volume = () => root.querySelector<HTMLInputElement>('input[data-action="volume"]')!;
  const setVolume = async (v: string) => {
    volume().value = v;
    volume().dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  };

  it("defaults to 0.8", async () => {
    const s = mountStation(root, opts());
    await flush();
    expect(s.state().volume).toBe(0.8);
    expect(volume().value).toBe("80");
  });

  it("the range sets the clip volume and a quieter bed, and is remembered", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    const s = mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    await setVolume("50");
    expect(s.state().volume).toBe(0.5);
    const clip = audios.find((a) => !a.loop)!;
    const bed = audios.find((a) => a.loop)!;
    expect(clip.volume).toBe(0.5);
    expect(bed.volume).toBeCloseTo(0.2);
    expect(localStorage.getItem("dfm.volume")).toBe("0.5");
  });

  it("starts from the remembered volume and ignores nonsense", async () => {
    localStorage.setItem("dfm.volume", "0.3");
    expect(mountStation(root, opts()).state().volume).toBe(0.3);
    localStorage.setItem("dfm.volume", "loud");
    document.body.innerHTML = '<div id="station"></div>';
    root = document.getElementById("station")!;
    expect(mountStation(root, opts()).state().volume).toBe(0.8);
  });
});

describe("station: on-air panel", () => {
  const titles = () => [...root.querySelectorAll(".up-next li")].map((li) => li.querySelector(".title")!.textContent);
  const nowRows = () => [...root.querySelectorAll(".up-next li.now")];

  it("shows a hint and no rows while the switch is off", async () => {
    mountStation(root, opts());
    await flush();
    expect(root.querySelectorAll(".up-next li")).toHaveLength(0);
    expect(root.querySelector(".side")!.textContent).toContain("スイッチを入れると、ここにお便りが並びます。");
  });

  it("puts the episode playing first, then the prefetched one, and drops the first when the second starts", async () => {
    const one = view("epO", [["a", [dj("o1")]]]);
    const two = view("epT", [["b", [dj("t1")]]]);
    nextReplies = [ok(one), ok(two), ok(view("epU", [["c", [dj("u1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["o1"]));
    await vi.waitFor(() => expect(titles()).toEqual(["曲A", "曲B"]));
    expect(root.querySelector(".side h2")!.textContent).toBe("オンエア");
    expect(nowRows()).toHaveLength(1);
    held[0]!.onend?.();
    await vi.waitFor(() => expect(spoken).toEqual(["o1", "t1"]));
    await vi.waitFor(() => expect(titles()[0]).toBe("曲B"));
    expect(nowRows().map((li) => li.querySelector(".title")!.textContent)).toEqual(["曲B"]);
    expect(titles().filter((t) => t === "曲A")).toHaveLength(0);
  });

  it("empties and shows the hint again after turning off", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    await power();
    expect(root.querySelectorAll(".up-next li")).toHaveLength(0);
    expect(root.querySelector(".side")!.textContent).toContain("スイッチを入れると");
  });

  it("says 私も from the on-air row once, for the segment's first letter, and the player shows it as sent", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    calls.length = 0;
    const btn = () => root.querySelector<HTMLButtonElement>('.up-next li.now [data-action="panel-watashimo"]')!;
    expect(root.querySelectorAll('.up-next li:not(.now) [data-action="panel-watashimo"]')).toHaveLength(0);
    btn().click();
    btn().click();
    await flush();
    expect(calls).toEqual(["POST /letters"]);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "watashimo", itemId: "a", parentLetterId: "L1" });
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toContain("届けました");
  });

  it("shows a 私も said in the panel as sent on the player card", async () => {
    nextReplies = [ok(view("epL", [["a", [letter("L1", "l1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["l1"]));
    root.querySelector<HTMLButtonElement>('.up-next li.now [data-action="panel-watashimo"]')!.click();
    await flush();
    expect((el("watashimo") as HTMLButtonElement).disabled).toBe(true);
    expect(el("watashimo").textContent).toContain("届けました");
  });

  it("shows a 私も said in the player card as sent in the panel", async () => {
    nextReplies = [ok(view("epL", [["a", [letter("L1", "l1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["l1"]));
    el("watashimo").click();
    await flush();
    const panel = root.querySelector<HTMLButtonElement>('.up-next li.now [data-action="panel-watashimo"]')!;
    expect(panel.disabled).toBe(true);
    expect(panel.textContent).toContain("届けました");
  });

  it("sends a reply typed in the on-air row", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    calls.length = 0;
    const ta = root.querySelector<HTMLTextAreaElement>(".up-next li.now textarea")!;
    expect(ta.getAttribute("maxlength")).toBe("200");
    ta.value = "いい曲";
    root.querySelector<HTMLFormElement>(".up-next li.now form")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual(["POST /letters"]);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "reply", body: "いい曲", itemId: "a", parentLetterId: "L1" });
    // Cleared and still usable: a second word to the same letter goes out.
    expect(ta.value).toBe("");
    expect(ta.disabled).toBe(false);
    ta.value = "もう一言";
    root.querySelector<HTMLFormElement>(".up-next li.now form")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual(["POST /letters", "POST /letters"]);
  });

  it("a reply from the panel leaves the player card's reply input open", async () => {
    nextReplies = [ok(view("epL", [["a", [letter("L1", "l1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["l1"]));
    el("reply").click();
    await flush();
    expect(root.querySelector("form.reply")).not.toBeNull();
    const ta = root.querySelector<HTMLTextAreaElement>(".up-next li.now textarea")!;
    ta.value = "いい曲";
    root.querySelector<HTMLFormElement>(".up-next li.now form")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    expect(root.querySelector("form.reply")).not.toBeNull();
  });

  it("a failed post can be tried again", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    const real = fetch as unknown as ReturnType<typeof vi.fn>;
    const impl = real.getMockImplementation()!;
    real.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const btn = () => root.querySelector<HTMLButtonElement>('.up-next li.now [data-action="panel-watashimo"]')!;
    btn().click();
    await flush();
    expect(btn().disabled).toBe(false);
    real.mockImplementation(impl);
    btn().click();
    await flush();
    expect(btn().disabled).toBe(true);
  });

  it("lists nothing as on air once the day's limit is reached, and not between episodes", async () => {
    const one = view("epO", [["a", [dj("o1")]]]);
    nextReplies = [ok(one), json(429, { error: "limit" })];
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(root.querySelector(".station-status")!.textContent).toContain("今日の分はここまで"));
    expect(root.querySelectorAll(".up-next li.now")).toHaveLength(0);
    expect(root.querySelectorAll(".up-next li")).toHaveLength(0);
  });

  it("drops the on-air row while the next episode is awaited", async () => {
    const one = view("epO", [["a", [dj("o1")]]]);
    let release: (r: Response) => void = () => {};
    nextReplies = [ok(one), () => new Promise<Response>((r) => (release = r))];
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(root.querySelector(".station-status")!.textContent).toContain("チューニング中"));
    expect(root.querySelectorAll(".up-next li.now")).toHaveLength(0);
    autoEnd = false;
    release(new Response(JSON.stringify({ episode: view("epU", [["c", [dj("u1")]]]), station: { key: "world", label: "Dococa FM" } }), { status: 200, headers: { "content-type": "application/json" } }));
    await vi.waitFor(() => expect(root.querySelectorAll(".up-next li.now")).toHaveLength(1));
  });

  it("offers no reactions on a row whose segment has no letter", async () => {
    nextReplies = [ok(epB()), ok(view("epV", [["c", [dj("v1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["x1"]));
    expect(root.querySelector(".up-next li.now")).not.toBeNull();
    expect(root.querySelector(".up-next li.now button")).toBeNull();
  });
});

describe("station: reactions", () => {
  const onLetter = async () => {
    nextReplies = [ok(view("epL", [["a", [letter("L1", "l1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["l1"]));
    calls.length = 0;
  };

  it("sends 私も for the letter on air", async () => {
    await onLetter();
    el("watashimo").click();
    await flush();
    expect(calls).toEqual(["POST /letters"]);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "watashimo", itemId: "a", parentLetterId: "L1" });
    expect(el("watashimo").textContent).toContain("届けました");
  });

  it("sends a reply typed under the letter", async () => {
    await onLetter();
    el("reply").click();
    await flush();
    root.querySelector<HTMLInputElement>("form.reply input")!.value = "いい曲";
    root.querySelector<HTMLFormElement>("form.reply")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "reply", body: "いい曲", itemId: "a", parentLetterId: "L1" });
  });

  it("links out to the work", async () => {
    await onLetter();
    expect(root.querySelector(".react")!.textContent).toContain("私も");
    expect(root.querySelector('[data-action="again"] a')!.getAttribute("href")).toBe("https://open.spotify.com/a");
  });
});

describe("station: listens", () => {
  const listens = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "/listens");

  it("reports each letter once when its line starts, with the segment index, and not the DJ's lines or a reply", async () => {
    nextReplies = [ok(view("epL", [["a", [{ type: "dj", text: "d1" }, letter("L1", "l1")]], ["b", [{ ...letter("R1", "r1"), kind: "reply" }, letter("L2", "l2")]]]))];
    mountStation(root, opts({ listensUrl: "/listens" }));
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1", "r1", "l2"]));
    const bodies = listens().map((c) => [c[1].method, c[1].headers["content-type"], JSON.parse(c[1].body)]);
    expect(bodies).toEqual([
      ["POST", "application/json", { episodeId: "epL", letterId: "L1", segmentIndex: 0 }],
      ["POST", "application/json", { episodeId: "epL", letterId: "L2", segmentIndex: 1 }],
    ]);
  });

  it("does not report the same letter of the same episode twice", async () => {
    nextReplies = [ok(view("epL", [["a", [letter("L1", "l1"), letter("L1", "l1")]]]))];
    mountStation(root, opts({ listensUrl: "/listens" }));
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["l1", "l1"]));
    expect(listens()).toHaveLength(1);
  });

  it("keeps playing when the report fails, and sends nothing without a url", async () => {
    nextReplies = [ok(view("epL", [["a", [letter("L1", "l1")]]]))];
    const base = (fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => (url === "/listens" ? Promise.reject(new Error("offline")) : base(url, init))));
    mountStation(root, opts({ listensUrl: "/listens" }));
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["l1"]));
    root.innerHTML = "";
    vi.stubGlobal("fetch", vi.fn(base));
    forgetReportedListens();
    spoken.length = 0;
    nextReplies = [ok(view("epM", [["a", [letter("L2", "l2")]]]))];
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["l2"]));
    expect(listens()).toHaveLength(0);
  });
});

describe("resumeAt", () => {
  const segs = view("v", [["a", [dj("a1"), letter("L1", "l1")]], ["b", [dj("b1"), letter("L2", "l2")]]]);

  it("keeps the stored segment and line while that segment still reads the stored letter", () => {
    expect(resumeAt(segs, { seg: 1, line: 1, letterId: "L2" })).toEqual({ seg: 1, line: 1 });
  });

  it("moves to the start of the segment that reads the letter now", () => {
    expect(resumeAt(segs, { seg: 0, line: 1, letterId: "L2" })).toEqual({ seg: 1, line: 0 });
    expect(resumeAt(segs, { seg: 5, line: 0, letterId: "L1" })).toEqual({ seg: 0, line: 0 });
  });

  it("falls back to the indices when no letter was stored or no segment reads it", () => {
    expect(resumeAt(segs, { seg: 1, line: 0 })).toEqual({ seg: 1, line: 0 });
    expect(resumeAt(segs, { seg: 0, line: 9, letterId: "gone" })).toEqual({ seg: 0, line: 0 });
    expect(resumeAt(segs, { seg: 1, line: 2, letterId: "gone" })).toBeNull();
    expect(resumeAt(segs, { seg: 2, line: 0 })).toBeNull();
  });

  it("treats the end marker of the last segment as played to its end", () => {
    expect(resumeAt(segs, { seg: 1, line: 2, letterId: "L2" })).toBeNull();
  });
});

describe("station: the dial and the first ask", () => {
  const one = (id: string) => view(id, [["a", [dj(`${id}-1`)]]]);
  const turn = (value: string) => {
    const input = el("dial") as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  it("sends first only with the first ask of a visit, and the dial with every ask", async () => {
    nextReplies = [ok(one("e1")), ok(one("e2"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    await power();
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["e2"]));
    expect(bodies).toEqual([
      { dial: 0.4, first: true },
      { dial: 0.4, first: false },
    ]);
  });

  it("does not open again after a resumed episode", async () => {
    resumeReply = ok(one("r1"));
    nextReplies = [ok(one("e2"))];
    autoEnd = false;
    mountStation(root, opts({ stationKey: "mine" }));
    await power();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]!.first).toBe(false);
  });

  it("the browser's own dial wins over the page's", async () => {
    localStorage.setItem("dfm.dial", "0.8");
    nextReplies = [ok(one("e1"))];
    mountStation(root, opts({ stationKey: "mine", dial: 0.2 }));
    expect((el("dial") as HTMLInputElement).value).toBe("0.8");
    await power();
    expect(bodies[0]!.dial).toBe(0.8);
  });

  it("turning the knob keeps the value, drops the queued episode and asks again with it, once it rests", async () => {
    nextReplies = [ok(one("e1")), ok(one("e2")), ok(one("e3"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", dial: 0.3 }));
    await power();
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["e2"]));
    turn("0.6");
    turn("0.9");
    expect(localStorage.getItem("dfm.dial")).toBe("0.9");
    expect(posts()).toBe(2);
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["e3"]));
    expect(posts()).toBe(3);
    expect(bodies[2]).toEqual({ dial: 0.9, first: false });
    expect(calls.some((c) => c.includes("/settings/dial"))).toBe(false);
  });

  it("drops an answer asked for with the old dial that arrives after the turn", async () => {
    let release!: () => void;
    const late = () => new Promise<Response>((r) => (release = () => void ok(one("old"))().then(r)));
    nextReplies = [ok(one("e1")), late, ok(one("new"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine" }));
    await power();
    await vi.waitFor(() => expect(posts()).toBe(2));
    turn("1");
    await vi.waitFor(() => expect(posts()).toBe(3));
    release();
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["new"]));
    await flush();
    expect(s.state().queue.map((e) => e.id)).toEqual(["new"]);
  });

  it("carries the letter asked for on the first ask only", async () => {
    nextReplies = [ok(one("e1")), ok(one("e2"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", letterId: "L9" }));
    await power();
    await vi.waitFor(() => expect(s.state().queue).toHaveLength(1));
    expect(bodies[0]!.letterId).toBe("L9");
    expect(bodies[1]).not.toHaveProperty("letterId");
  });

  it("keeps the letter asked for until an ask carrying it is answered", async () => {
    nextReplies = [json(503, { error: "unavailable" }), ok(one("e1")), ok(one("e2"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", letterId: "L9" }));
    await power();
    expect(s.state().power).toBe("failed");
    await power();
    await vi.waitFor(() => expect(s.state().queue).toHaveLength(1));
    expect(bodies.map((b) => b.letterId)).toEqual(["L9", "L9", undefined]);
    expect(bodies[1]!.first).toBe(true);
  });

  it("plays the letter asked for first instead of resuming the last visit", async () => {
    localStorage.setItem("dfm.pos:mine", JSON.stringify({ episodeId: "old", seg: 0, line: 0 }));
    resumeReply = ok(one("r1"));
    resumeByIdReply = ok(one("old"));
    nextReplies = [ok(one("asked"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", letterId: "L9" }));
    await power();
    expect(calls.some((c) => c.startsWith("GET /stations/world.json"))).toBe(false);
    expect(s.state().current?.id).toBe("asked");
    expect(bodies[0]).toEqual({ dial: 0.3, first: true, letterId: "L9" });
  });

  it("shows no dial on a public station", async () => {
    mountStation(root, opts({ stationKey: "s:hiro", dial: 0.5 }));
    await flush();
    expect(root.querySelector(".knob-dial")).toBeNull();
  });
});
