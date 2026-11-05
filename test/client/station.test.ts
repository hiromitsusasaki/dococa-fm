import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  "station.upNext": "このあと流れるもの",
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
let nextReplies: Array<() => Promise<Response>>;
let resumeReply: () => Promise<Response>;
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
  nextReplies = [];
  resumeReply = none;
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
      if (url === "/stations/world/next") return (nextReplies.shift() ?? json(503, { error: "unavailable" }))();
      return json(200, {})();
    }),
  );
  localStorage.clear();
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

  it("lists what is still to come, with kind, title and creator but no numbers", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    const rows = [...root.querySelectorAll(".up-next li")].map((li) => li.textContent);
    expect(root.querySelector(".side")!.textContent).toContain("このあと流れるもの");
    expect(rows[0]).toContain("映画");
    expect(rows[0]).toContain("曲B");
    expect(rows[0]).toContain("作者B");
    expect(rows.join(" ")).not.toMatch(/\d/);
    expect(root.querySelector("ol")).toBeNull();
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
    expect(bed.volume).toBeCloseTo(0.075);
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
