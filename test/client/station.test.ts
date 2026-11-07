import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetReportedListens, resumeAt } from "../../src/client/playback";
import { isNight, mountStation as mountStationOnce, type StationOptions, wireSendModal } from "../../src/client/station";

/** Every station a test mounts, so `afterEach` stops it: a station left mounted keeps its document listeners and its line player running into the next test. */
let live: Array<{ unmount(): void; done: boolean }> = [];
const mountStation = (...args: Parameters<typeof mountStationOnce>) => {
  const s = mountStationOnce(...args);
  const handle = { done: false, unmount: s.unmount };
  live.push(handle);
  return {
    ...s,
    unmount() {
      if (handle.done) return;
      handle.done = true;
      s.unmount();
    },
  };
};

const strings: Record<string, string> = {
  "station.onOff": "ラジオをつける / 止める",
  "station.on": "ラジオをつける",
  "station.off": "止める",
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
  "player.watashimo": "私も",
  "player.reply": "一言を送る",
  "player.send": "送る",
  "player.sent": "届けました",
  "player.replyLabel": "一言",
  "player.again": "この作品を聴く・観る",
  "player.sendFailed": "送れませんでした",
  "player.sentToast": "送りました",
  "station.dialNear": "近く",
  "station.dialFar": "遠く",
  "station.dialHint": "次のお便りから効きます",
  "station.dialLocked": "お便りを 3 通送ると、ダイヤルが効きはじめます",
  "station.dialReady": "ダイヤルが効くようになりました",
  "station.searching": "電波を探しています…",
  "station.playFromToast": "このお便りから流します",
  "station.playFromLetter": "このお便りから聴く",
  "station.share": "リンクをコピー",
  "station.shared": "リンクをコピーしました",
  "home.put": "お便りを送る",
  "home.sendLead": "好きな曲・本・映画について、200 字まで。DJ が読み上げます。",
  "share.x": "X で共有",
  "share.native": "共有",
  "share.text": "{work} · {sender}のお便り — Dococa FM",
  "reply.addName": "ラジオネームとお住まいを添える（任意）",
  "reply.invalidName": "ラジオネームとお住まいを確かめてください",
  "settings.radioName": "ラジオネーム",
  "lang.confirmPlaying": "切り替えると再生が止まります。続けますか？",
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
  for (const h of live) if (!h.done) {
    h.done = true;
    h.unmount();
  }
  live = [];
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

  it("the home's right column opens with the send panel (heading, one line, the button), then the on-air panel; only where asked", async () => {
    mountStation(root, opts({ stationKey: "mine", send: true }));
    await flush();
    const [send, onAir] = [...root.querySelector("aside.side")!.children];
    expect(send!.matches("section.panel.send-panel")).toBe(true);
    expect(send!.querySelector("h2")!.textContent).toBe("お便りを送る");
    expect(send!.querySelector("p")!.textContent).toBe("好きな曲・本・映画について、200 字まで。DJ が読み上げます。");
    expect(send!.querySelector("a")!.getAttribute("href")).toBe("/put");
    expect(send!.querySelector("a")!.hasAttribute("data-open-send")).toBe(true);
    expect(onAir!.matches("section.panel")).toBe(true);
    expect(onAir!.querySelector("h2")!.textContent).toBe("オンエア");
  });

  it("shows no send button on a station page that did not ask for it", async () => {
    mountStation(root, opts());
    await flush();
    expect(root.querySelector("[data-open-send]")).toBeNull();
    expect(root.querySelector(".send-panel")).toBeNull();
  });

  it("remembers the first switch-on in dfm.seen, so the home can show its short hero next time", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await flush();
    expect(localStorage.getItem("dfm.seen")).toBeNull();
    await power();
    expect(localStorage.getItem("dfm.seen")).toBe("1");
  });

  it("asks before the language switch stops a radio that is on, and lets it through when the answer is no or the radio is off", async () => {
    const form = document.createElement("form");
    form.setAttribute("data-confirm", "");
    form.innerHTML = '<button type="submit" name="lang" value="en">EN</button>';
    document.body.append(form);
    const asked = vi.fn();
    vi.stubGlobal("confirm", asked);
    const submit = () => {
      const e = new Event("submit", { cancelable: true, bubbles: true });
      form.dispatchEvent(e);
      return e.defaultPrevented;
    };
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await flush();
    asked.mockReturnValue(false);
    expect(submit()).toBe(false);
    expect(asked).not.toHaveBeenCalled();
    await power();
    expect(submit()).toBe(true);
    expect(asked).toHaveBeenCalledWith("切り替えると再生が止まります。続けますか？");
    asked.mockReturnValue(true);
    expect(submit()).toBe(false);
    form.remove();
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
    expect(bed.volume).toBeCloseTo(0.15);
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

  it("says 私も from the now-playing card once, for the segment's first letter, while the DJ still speaks", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    calls.length = 0;
    const btn = () => root.querySelector<HTMLButtonElement>('.now.panel [data-action="watashimo"]')!;
    btn().click();
    btn().click();
    await flush();
    expect(calls).toEqual(["POST /letters"]);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "watashimo", itemId: "a", parentLetterId: "L1" });
    expect(btn().disabled).toBe(true);
    expect(btn().textContent).toContain("届けました");
  });

  it("the on-air panel is the list only: no reactions and no share links on any row", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    expect(root.querySelector(".up-next li.now")).not.toBeNull();
    expect(root.querySelector(".side button, .side form, .side .share")).toBeNull();
  });

  it("sends a reply typed on the now-playing card", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    calls.length = 0;
    const ta = root.querySelector<HTMLTextAreaElement>(".now form.reply textarea")!;
    expect(ta.getAttribute("maxlength")).toBe("200");
    ta.value = "いい曲";
    root.querySelector<HTMLFormElement>(".now form.reply")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual(["POST /letters"]);
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "reply", body: "いい曲", itemId: "a", parentLetterId: "L1" });
    // Cleared and still usable: a second word to the same letter goes out.
    expect(ta.value).toBe("");
    expect(ta.disabled).toBe(false);
    ta.value = "もう一言";
    root.querySelector<HTMLFormElement>(".now form.reply")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    expect(calls).toEqual(["POST /letters", "POST /letters"]);
  });

  it("keeps words typed on the now-playing card while the reply was on its way", async () => {
    nextReplies = [ok(epA()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    let answer!: (r: Response) => void;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    const ta = root.querySelector<HTMLTextAreaElement>(".now form.reply textarea")!;
    ta.value = "a";
    root.querySelector<HTMLFormElement>(".now form.reply")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));
    await flush();
    ta.value = "b";
    answer(new Response(null, { status: 200 }));
    await flush();
    expect(root.querySelector<HTMLTextAreaElement>(".now form.reply textarea")!.value).toBe("b");
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
    const btn = () => root.querySelector<HTMLButtonElement>('.now [data-action="watashimo"]')!;
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

  it("offers no reactions on the card when the segment has no letter", async () => {
    nextReplies = [ok(epB()), ok(view("epV", [["c", [dj("v1")]]]))];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["x1"]));
    expect(root.querySelector(".up-next li.now")).not.toBeNull();
    expect(root.querySelector(".now .react")).toBeNull();
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
    root.querySelector<HTMLTextAreaElement>("form.reply textarea")!.value = "いい曲";
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

describe("station: a name and place before a reply", () => {
  const template =
    '<template id="place-fields"><label><span>国</span><select name="placeCountry"><option value="">選ばない</option><option value="JP">日本</option></select></label><label><span>都道府県・州</span><select name="placeRegion"><option value="">選ばない</option><option value="32">島根県</option></select></label></template>';
  const onLetter = async (askName: boolean) => {
    document.body.insertAdjacentHTML("beforeend", template);
    // The page's own cloner (PlaceFields' script), as the server draws it.
    const clone = (e: Event) => {
      const d = e.target as HTMLDetailsElement;
      const slot = d.querySelector?.(".place-slot");
      if (d.open && d.matches("details.reply-name") && slot && !slot.firstElementChild) slot.append((document.getElementById("place-fields") as HTMLTemplateElement).content.cloneNode(true));
    };
    document.addEventListener("toggle", clone, true);
    nextReplies = [ok(view("epL", [["a", [dj("d1"), letter("L1", "l1")]]]))];
    autoEnd = false;
    mountStation(root, opts({ askName }));
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["d1"]));
    calls.length = 0;
    return () => document.removeEventListener("toggle", clone, true);
  };
  const submit = () => root.querySelector<HTMLFormElement>(".now form.reply")!.dispatchEvent(new CustomEvent("submit", { detail: {}, bubbles: true, cancelable: true }));

  it("offers the collapsed line only to a listener without a radio name", async () => {
    (await onLetter(false))();
    expect(root.querySelector(".now details.reply-name")).toBeNull();
  });

  it("sends the name and the place picked from the page's lists with the reply, keeps them through a redraw, then stops asking", async () => {
    const off = await onLetter(true);
    const details = root.querySelector<HTMLDetailsElement>(".now form.reply details.reply-name")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("ラジオネームとお住まいを添える（任意）");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    held.shift()!.onend?.();
    await vi.waitFor(() => expect(spoken).toEqual(["d1", "l1"]));
    // The radio redrew the card on the next line: the lists cloned into it are still there.
    root.querySelector<HTMLInputElement>('.now input[name="radioName"]')!.value = "しずく";
    root.querySelector<HTMLSelectElement>('.now select[name="placeCountry"]')!.value = "JP";
    root.querySelector<HTMLSelectElement>('.now select[name="placeRegion"]')!.value = "32";
    root.querySelector<HTMLTextAreaElement>(".now form.reply textarea")!.value = "いい曲";
    submit();
    await flush();
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "reply", body: "いい曲", itemId: "a", parentLetterId: "L1", radioName: "しずく", placeCountry: "JP", placeRegion: "32" });
    expect(root.querySelector(".now details.reply-name")).toBeNull();
    off();
  });

  it("a refused name or place says so and keeps asking; a refused reply without them is the plain failure", async () => {
    const off = await onLetter(true);
    const real = fetch as unknown as ReturnType<typeof vi.fn>;
    const refused = () => Promise.resolve(new Response("", { status: 422 }));
    real.mockImplementationOnce(refused);
    root.querySelector<HTMLInputElement>('.now input[name="radioName"]')!.value = "しずく";
    root.querySelector<HTMLTextAreaElement>(".now form.reply textarea")!.value = "いい曲";
    submit();
    await flush();
    expect(root.querySelector(".station-status")!.textContent).toBe("ラジオネームとお住まいを確かめてください");
    expect(root.querySelector(".now details.reply-name")).not.toBeNull();
    real.mockImplementationOnce(refused);
    root.querySelector<HTMLInputElement>('.now input[name="radioName"]')!.value = "";
    submit();
    await flush();
    expect(root.querySelector(".station-status")!.textContent).toBe("送れませんでした");
    off();
  });

  it("a reply without a name goes as before, and the line stays for next time", async () => {
    const off = await onLetter(true);
    root.querySelector<HTMLTextAreaElement>(".now form.reply textarea")!.value = "いい曲";
    submit();
    await flush();
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ kind: "reply", body: "いい曲", itemId: "a", parentLetterId: "L1" });
    expect(root.querySelector(".now details.reply-name")).not.toBeNull();
    off();
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

describe("station: the dial wakes after three letters", () => {
  const one = (id: string) => view(id, [["a", [dj(`${id}-1`)]]]);
  const knob = () => root.querySelector<HTMLElement>(".knob-dial")!;
  const toastText = () => document.body.querySelector(".toast")?.textContent ?? null;
  const awake = (v: object, dialReady: boolean) => json(200, { episode: v, station: { key: "mine", label: "Dococa FM" }, dialReady });

  it("stays on the face but locked: no turning, a lock at its centre, the line in place of its name", async () => {
    sessionStorage.clear();
    mountStation(root, opts({ stationKey: "mine", dial: 0.4, dialReady: false }));
    await flush();
    expect(knob().classList.contains("locked")).toBe(true);
    expect(knob().querySelector(".knob-lock")).not.toBeNull();
    expect([...knob().querySelectorAll(".dial-end")].map((e) => e.textContent)).toEqual(["近く", "遠く"]);
    expect(knob().querySelector(".control-label")!.textContent).toBe("お便りを 3 通送ると、ダイヤルが効きはじめます");
    const input = el("dial") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    // Assistive technology hears why: the slider is described by the locked line, and the turning help is gone.
    expect(input.getAttribute("aria-describedby")).toBe("dial-locked");
    expect(document.getElementById("dial-locked")!.textContent!.trim()).toBe("お便りを 3 通送ると、ダイヤルが効きはじめます");
    expect(knob().hasAttribute("title")).toBe(false);
    input.value = "0.9";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(localStorage.getItem("dfm.dial")).toBeNull();
    expect(toastText()).toBeNull();
    // The scale's needle rests in the middle while the dial does nothing.
    expect(root.querySelector<HTMLElement>(".scale")!.style.getPropertyValue("--needle")).toBe("50%");
  });

  it("wakes when the next episode says so: the ring lights, the needle sweeps in once, a toast says it works", async () => {
    nextReplies = [awake(one("e1"), false), awake(one("e2"), true)];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", dial: 0.4, dialReady: false }));
    await flush();
    expect(knob().classList.contains("locked")).toBe(true);
    await power();
    // The first answer still says locked; the one fetched ahead says it woke.
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["e2"]));
    expect(knob().classList.contains("locked")).toBe(false);
    expect(knob().classList.contains("ready")).toBe(true);
    expect(knob().classList.contains("woke")).toBe(true);
    expect((el("dial") as HTMLInputElement).disabled).toBe(false);
    expect(knob().querySelector(".control-label")!.textContent).toBe("セレンディピティ");
    expect(toastText()).toBe("ダイヤルが効くようになりました");
    expect(localStorage.getItem("dfm.dialLocked")).toBeNull();
  });

  it("asks with the centre while locked, keeping the stored value; awake, it asks with the stored value again", async () => {
    localStorage.setItem("dfm.dial", "0.9");
    nextReplies = [awake(one("e1"), false), awake(one("e2"), true), awake(one("e3"), true)];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", dial: 0.4, dialReady: false }));
    await power();
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["e2"]));
    expect(bodies.map((b) => b.dial)).toEqual([0.5, 0.5]);
    expect(localStorage.getItem("dfm.dial")).toBe("0.9");
    expect(knob().getAttribute("title")).toBe(strings["station.dialHelp"] ?? "station.dialHelp");
    expect(el("dial").hasAttribute("aria-describedby")).toBe(false);
    // Awake: a turn now counts, and the next ask carries the browser's value.
    const input = el("dial") as HTMLInputElement;
    input.value = "0.9";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(bodies).toHaveLength(3));
    expect(bodies[2]!.dial).toBe(0.9);
  });

  it("wakes at load when this browser last saw it locked, once; a dial that was always awake says nothing", async () => {
    const a = mountStation(root, opts({ stationKey: "mine", dial: 0.4, dialReady: false }));
    await flush();
    expect(localStorage.getItem("dfm.dialLocked")).toBe("1");
    a.unmount();
    const b = mountStation(root, opts({ stationKey: "mine", dial: 0.4, dialReady: true }));
    await flush();
    expect(knob().classList.contains("woke")).toBe(true);
    expect(toastText()).toBe("ダイヤルが効くようになりました");
    b.unmount();
    mountStation(root, opts({ stationKey: "mine", dial: 0.4, dialReady: true }));
    await flush();
    expect(knob().classList.contains("ready")).toBe(true);
    expect(knob().classList.contains("woke")).toBe(false);
    expect(toastText()).toBeNull();
  });
});

describe("station: a letter card plays on this radio", () => {
  const one = (id: string) => view(id, [["a", [dj(`${id}-1`), letter(`${id}-L`, "l")]]]);
  let scrolled: ReturnType<typeof vi.fn>;
  const card = (id: string) => {
    const a = document.createElement("a");
    a.href = `/stations/mine?letter=${id}`;
    a.setAttribute("data-play-letter", id);
    a.innerHTML = "<span class='letter-card-text'>text</span>";
    document.body.append(a);
    return a;
  };
  /** True when the click was let through (the link would navigate). */
  const press = (target: Element, init: MouseEventInit = {}) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));

  beforeEach(() => {
    scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled as unknown as HTMLElement["scrollIntoView"];
  });

  it("an idle radio: the click stays on the page, the radio turns on with the letter as the first ask, and the page scrolls to the player", async () => {
    resumeReply = ok(one("old"));
    nextReplies = [ok(one("e1"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    const through = press(card("L5").querySelector("span")!);
    expect(through).toBe(false);
    await vi.waitFor(() => expect(s.state().power).toBe("on"));
    expect(bodies[0]).toEqual({ dial: 0.4, first: true, letterId: "L5" });
    expect(s.state().current?.id).toBe("e1");
    // A card asks for its letter: the last visit is not resumed.
    expect(calls.some((c) => c.startsWith("GET /stations/world.json"))).toBe(false);
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts[0]).toBe(root);
  });

  it("a playing radio starts again from the card's letter, dropping the queue", async () => {
    nextReplies = [ok(one("e1")), ok(one("e2")), ok(one("e3"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    await power();
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["e2"]));
    const cancel = (globalThis as unknown as { speechSynthesis: { cancel: ReturnType<typeof vi.fn> } }).speechSynthesis.cancel;
    const before = cancel.mock.calls.length;
    expect(spoken.at(-1)).toBe("e1-1");
    press(card("L7"));
    // The line being read is cut at the press, so the old episode never sounds under the new one.
    expect(cancel.mock.calls.length).toBeGreaterThan(before);
    await vi.waitFor(() => expect(s.state().current?.id).toBe("e3"));
    await vi.waitFor(() => expect(spoken.at(-1)).toBe("e3-1"));
    expect(spoken.filter((t) => t === "e1-1")).toHaveLength(1);
    expect(s.state().power).toBe("on");
    expect(bodies[2]).toEqual({ dial: 0.4, first: true, letterId: "L7" });
    expect(s.state().queue.map((e) => e.id)).not.toContain("e2");
  });

  it("a press during the first tuning takes over: the earlier answer is dropped", async () => {
    let release!: () => void;
    const late = () => new Promise<Response>((r) => (release = () => void ok(one("slow"))().then(r)));
    nextReplies = [late, ok(one("asked"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine" }));
    await power();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    press(card("L8"));
    await vi.waitFor(() => expect(s.state().current?.id).toBe("asked"));
    release();
    await flush();
    expect(s.state().current?.id).toBe("asked");
    expect(s.state().power).toBe("on");
  });

  it("a press after the day's limit asks again, and keeps asking ahead once it is answered", async () => {
    nextReplies = [ok(one("e1")), json(429, { error: "limit" }), ok(one("e2")), ok(one("e3"))];
    const s = mountStation(root, opts({ stationKey: "mine" }));
    await power();
    await vi.waitFor(() => expect(s.state().power).toBe("limit"));
    autoEnd = false;
    press(card("L3"));
    await vi.waitFor(() => expect(s.state().current?.id).toBe("e2"));
    expect(s.state().power).toBe("on");
    expect(bodies[2]).toMatchObject({ first: true, letterId: "L3" });
    await vi.waitFor(() => expect(s.state().queue.map((e) => e.id)).toEqual(["e3"]));
  });

  it("a press after a failure asks again", async () => {
    nextReplies = [json(503, { error: "unavailable" }), ok(one("e1"))];
    const s = mountStation(root, opts({ stationKey: "mine" }));
    await power();
    await vi.waitFor(() => expect(s.state().power).toBe("failed"));
    autoEnd = false;
    press(card("L4"));
    await vi.waitFor(() => expect(s.state().current?.id).toBe("e1"));
    expect(s.state().power).toBe("on");
  });

  it("leaves a modified click (a new tab) and other links alone", async () => {
    const s = mountStation(root, opts({ stationKey: "mine" }));
    expect(press(card("L9"), { metaKey: true })).toBe(true);
    const other = document.createElement("a");
    other.href = "/items/x";
    document.body.append(other);
    expect(press(other)).toBe(true);
    await flush();
    expect(s.state().power).toBe("off");
    expect(bodies).toEqual([]);
  });

  it("stops listening once unmounted", async () => {
    const s = mountStation(root, opts({ stationKey: "mine" }));
    s.unmount();
    expect(press(card("L1"))).toBe(true);
  });
});

describe("the home's send modal", () => {
  let unwire: () => void;
  let dialog: HTMLDialogElement;
  let frame: HTMLIFrameElement;
  let showModal: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML =
      '<a class="button" href="/put" data-open-send>お便りを送る</a><dialog class="send-modal"><form method="dialog"><button type="submit">閉じる</button></form><iframe data-src="/put?embed=1" title="お便りを送る"></iframe></dialog>';
    dialog = document.querySelector("dialog")!;
    frame = document.querySelector("iframe")!;
    // happy-dom swaps the frame's window on each load; a fixed one stands for the page inside it.
    Object.defineProperty(frame, "contentWindow", { value: {} as Window, configurable: true });
    showModal = vi.fn();
    close = vi.fn();
    dialog.showModal = showModal as unknown as HTMLDialogElement["showModal"];
    dialog.close = close as unknown as HTMLDialogElement["close"];
    unwire = wireSendModal(document);
  });
  afterEach(() => {
    unwire();
    vi.useRealTimers();
  });

  const press = (init: MouseEventInit = {}) => document.querySelector("[data-open-send]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  /** From the dialog's frame unless `source` says otherwise. */
  const message = (data: unknown, origin: string, source: Window | null = frame.contentWindow) => window.dispatchEvent(new MessageEvent("message", { data, origin, source }));

  it("the button opens the dialog instead of leaving the page, and the frame loads only then", () => {
    expect(frame.getAttribute("src")).toBeNull();
    expect(press()).toBe(false);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(frame.getAttribute("src")).toBe("/put?embed=1");
  });

  it("a modified click still opens /put in a new tab", () => {
    expect(press({ metaKey: true })).toBe(true);
    expect(showModal).not.toHaveBeenCalled();
  });

  it("closes on dfm:sent from its own origin once the confirmation has been seen, and loads a fresh page on the next open", () => {
    vi.useFakeTimers();
    press();
    frame.setAttribute("src", "/put?embed=1&sent=x");
    message({ type: "dfm:sent" }, location.origin);
    vi.advanceTimersByTime(1400);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    press();
    expect(frame.getAttribute("src")).toBe("/put?embed=1");
  });

  it("closes on dfm:close (Escape inside the frame) from its own origin, keeping the frame's page", () => {
    press();
    frame.setAttribute("src", "/put?embed=1&itemId=x");
    message({ type: "dfm:close" }, "https://evil.example");
    expect(close).not.toHaveBeenCalled();
    message({ type: "dfm:close" }, location.origin);
    expect(close).toHaveBeenCalledTimes(1);
    press();
    expect(frame.getAttribute("src")).toBe("/put?embed=1&itemId=x");
  });

  it("ignores the same message from another origin, and other messages", () => {
    vi.useFakeTimers();
    press();
    message({ type: "dfm:sent" }, "https://evil.example");
    message({ type: "other" }, location.origin);
    message(null, location.origin);
    // Past the sent page's delay, so an accepted dfm:sent would have closed it by now.
    vi.advanceTimersByTime(2000);
    expect(close).not.toHaveBeenCalled();
  });

  it("a modal opened again before the sent page's close keeps open", () => {
    vi.useFakeTimers();
    press();
    message({ type: "dfm:sent" }, location.origin);
    press();
    vi.advanceTimersByTime(2000);
    expect(close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores a same-origin message from a window other than its frame", () => {
    vi.useFakeTimers();
    press();
    message({ type: "dfm:sent" }, location.origin, window);
    message({ type: "dfm:close" }, location.origin, window);
    message({ type: "dfm:close" }, location.origin, null);
    vi.advanceTimersByTime(2000);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("station: the face explains itself", () => {
  const toastText = () => document.body.querySelector(".toast")?.textContent ?? null;

  it("the dial has Near and Far labels on either side", async () => {
    mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    await flush();
    const ends = [...root.querySelectorAll(".knob-dial .dial-end")].map((e) => e.textContent);
    expect(ends).toEqual(["近く", "遠く"]);
  });

  it("the first release of the dial hints once per session", async () => {
    sessionStorage.clear();
    mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    const input = el("dial") as HTMLInputElement;
    input.value = "0.7";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toastText()).toBe("次のお便りから効きます");
    document.body.querySelector(".toast")!.remove();
    input.value = "0.9";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toastText()).toBeNull();
  });

  it("while the first ask is pending the status says the radio is searching", async () => {
    let answer!: (r: Response) => void;
    nextReplies = [() => new Promise<Response>((r) => (answer = r))];
    autoEnd = false;
    const s = mountStation(root, opts());
    await power();
    expect(s.state().power).toBe("tuning");
    expect(root.querySelector(".station-status")!.textContent).toBe("電波を探しています…");
    answer(await ok(epB())());
    await vi.waitFor(() => expect(s.state().power).toBe("on"));
    expect(root.querySelector(".station-status")!.textContent).toBe("");
  });

  it("pressing 私も toasts, and a new toast replaces the old one", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    root.querySelector<HTMLButtonElement>('.now [data-action="watashimo"]')!.click();
    await vi.waitFor(() => expect(toastText()).toBe("送りました"));
    expect(document.body.querySelectorAll(".toast")).toHaveLength(1);
    expect(document.body.querySelector(".toast")!.getAttribute("role")).toBe("status");
  });

  it("a card press toasts that it plays from this letter, and the toast goes away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      HTMLElement.prototype.scrollIntoView = vi.fn() as unknown as HTMLElement["scrollIntoView"];
      nextReplies = [ok(epB())];
      autoEnd = false;
      mountStation(root, opts({ stationKey: "mine" }));
      const a = document.createElement("a");
      a.href = "/stations/mine?letter=L5";
      a.setAttribute("data-play-letter", "L5");
      document.body.append(a);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(toastText()).toBe("このお便りから流します");
      vi.advanceTimersByTime(2600);
      expect(toastText()).toBeNull();
      a.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the on-air row shows the work's picture, other rows do not", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(root.querySelector(".up-next li.now")).not.toBeNull());
    const thumb = root.querySelector<HTMLImageElement>(".up-next li.now img.thumb")!;
    expect(thumb.getAttribute("src")).toBe("https://img/a.jpg");
    expect(thumb.getAttribute("width")).toBe("40");
    expect(root.querySelectorAll(".up-next li:not(.now) img")).toHaveLength(0);
  });
});

describe("station: a letter's link and sharing", () => {
  const toastText = () => document.body.querySelector(".toast")?.textContent ?? null;
  const label = () => root.querySelector("#station-switch-label")!.textContent;
  const one = (id: string) => view(id, [["a", [dj(`${id}-1`)]]]);
  const setClipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { value, configurable: true });

  it("a primed radio's switch says it will play from the letter, and plays nothing before the press", async () => {
    nextReplies = [ok(one("asked"))];
    autoEnd = false;
    const s = mountStation(root, opts({ stationKey: "mine", letterId: "L9" }));
    await flush();
    expect(label()).toBe("このお便りから聴く");
    expect(calls).toEqual([]);
    expect(s.state().power).toBe("off");
    await power();
    expect(bodies[0]).toEqual({ dial: 0.3, first: true, letterId: "L9" });
    await vi.waitFor(() => expect(s.state().power).toBe("on"));
    expect(label()).toBe("止める");
    el("power").click();
    await flush();
    // The letter is used: off again is the plain switch.
    expect(label()).toBe("ラジオをつける");
  });

  it("an unprimed radio's switch reads as always", async () => {
    mountStation(root, opts({ stationKey: "mine" }));
    await flush();
    expect(label()).toBe("ラジオをつける");
  });

  it("an echo of the listener's own letter (a reply or 私も) has no share button: it has no page", async () => {
    for (const kind of ["reply", "watashimo"] as const) {
      root.innerHTML = "";
      nextReplies = [ok(view(`ep-${kind}`, [["a", [dj("e1"), { ...letter("R1", "r1"), kind }]]]))];
      autoEnd = false;
      const s = mountStation(root, opts());
      await power();
      await vi.waitFor(() => expect(root.querySelector(".now .react")).not.toBeNull());
      expect(root.querySelector(".now .share")).toBeNull();
      expect(root.querySelector('.now [data-action="watashimo"]')).not.toBeNull();
      s.unmount();
    }
  });

  it("the now-playing card's copy button copies the letter's page and toasts", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    try {
      nextReplies = [ok(epA())];
      autoEnd = false;
      mountStation(root, opts());
      await power();
      await vi.waitFor(() => expect(root.querySelector(".now .share [data-copy]")).not.toBeNull());
      expect(root.querySelectorAll("[data-copy]")).toHaveLength(1);
      const button = root.querySelector<HTMLButtonElement>(".now .share [data-copy]")!;
      expect(button.textContent).toBe("リンクをコピー");
      button.click();
      await flush();
      expect(writeText).toHaveBeenCalledWith(`${location.origin}/letters/L1`);
      expect(toastText()).toBe("リンクをコピーしました");
    } finally {
      setClipboard(undefined);
    }
  });

  it("the now-playing card shares the letter to X with the short text and the letter's page, in a new tab", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(root.querySelector(".now .share a")).not.toBeNull());
    const x = root.querySelector<HTMLAnchorElement>(".now .share a")!;
    expect(x.textContent).toBe("X で共有");
    expect([x.target, x.rel]).toEqual(["_blank", "noopener"]);
    const intent = new URL(x.href);
    expect(intent.origin + intent.pathname).toBe("https://x.com/intent/post");
    expect(Object.fromEntries(intent.searchParams)).toEqual({ text: "曲A · しずくさんのお便り — Dococa FM", url: `${location.origin}/letters/L1` });
  });

  it("offers the device's share sheet only where the browser has one, with the title, short text and page", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(root.querySelector(".now .share [data-share]")).not.toBeNull());
    expect(root.querySelector<HTMLButtonElement>(".now .share [data-share]")!.hidden).toBe(true);
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    try {
      held.shift()!.onend?.();
      await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>(".now .share [data-share]")!.hidden).toBe(false));
      const button = root.querySelector<HTMLButtonElement>(".now .share [data-share]")!;
      expect(button.textContent).toBe("共有");
      button.click();
      await flush();
      expect(share).toHaveBeenCalledWith({ title: "Dococa FM", text: "曲A · しずくさんのお便り — Dococa FM", url: `${location.origin}/letters/L1` });
    } finally {
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    }
  });

  it("without the clipboard API the copy button shows the link to copy by hand", async () => {
    setClipboard(undefined);
    const ask = vi.fn(() => null);
    vi.stubGlobal("prompt", ask);
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(root.querySelector(".now .share [data-copy]")).not.toBeNull());
    root.querySelector<HTMLButtonElement>(".now .share [data-copy]")!.click();
    await flush();
    expect(ask).toHaveBeenCalledWith("リンクをコピー", `${location.origin}/letters/L1`);
    expect(toastText()).toBeNull();
  });
});

describe("station: small joys", () => {
  type Played = { type: string; hz: number; gain: number };
  class FakeCtx {
    state = "running";
    currentTime = 0;
    destination = {};
    played: Played[] = [];
    tapped: unknown[] = [];
    private last = { type: "", frequency: { value: 0 } };
    constructor() {
      ctxs.push(this);
    }
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
    createOscillator() {
      const o = { type: "", frequency: { value: 0 }, connect: (g: unknown) => g, start() {}, stop() {} };
      this.last = o;
      return o;
    }
    createGain() {
      const ctx = this;
      return {
        gain: { setValueAtTime: (v: number) => ctx.played.push({ type: ctx.last.type, hz: ctx.last.frequency.value, gain: v }), exponentialRampToValueAtTime() {} },
        connect: (d: unknown) => d,
      };
    }
    createMediaElementSource(el: unknown) {
      if (tapThrows) throw new Error("already tapped");
      this.tapped.push(el);
      return { connect() {} };
    }
    createAnalyser() {
      return { fftSize: 0, connect() {}, getByteTimeDomainData: (b: Uint8Array) => b.fill(160) };
    }
  }
  let ctxs: FakeCtx[];
  let tapThrows: boolean;
  const sounds = () => ctxs.flatMap((c) => c.played);
  const scale = () => root.querySelector<HTMLElement>(".scale")!;

  beforeEach(() => {
    ctxs = [];
    tapThrows = false;
    vi.stubGlobal("AudioContext", FakeCtx);
    document.documentElement.removeAttribute("data-night");
    document.documentElement.removeAttribute("data-on-air");
  });
  afterEach(() => vi.useRealTimers());

  it("switching on lights the lamp and sweeps the needle once, which then drifts while on air", async () => {
    nextReplies = [() => new Promise<Response>(() => {})];
    mountStation(root, opts());
    await flush();
    expect(scale().className).toBe("scale");
    expect(scale().style.getPropertyValue("--needle")).toBe("50%");
    await power();
    expect(scale().className).toBe("scale lit");
    expect(root.querySelector(".face .live")).toBeNull();
    expect(root.querySelector(".station-status")!.textContent).toBe("電波を探しています…");
  });

  it("on air the needle drifts and the ON AIR lamp is lit", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    expect(scale().style.getPropertyValue("--needle")).toBe("42%");
    await power();
    await vi.waitFor(() => expect(scale().className).toBe("scale lit sweep"));
    expect(root.querySelector(".face .live")).not.toBeNull();
  });

  it("each detent of the dial moves the needle and clicks quietly, scaled by the volume, and only while the radio is on", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    localStorage.setItem("dfm.volume", "0.5");
    mountStation(root, opts({ stationKey: "mine", dial: 0.4 }));
    const dial = el("dial") as HTMLInputElement;
    const turn = (v: string) => {
      dial.value = v;
      dial.dispatchEvent(new Event("input", { bubbles: true }));
    };
    turn("0.5");
    expect(scale().style.getPropertyValue("--needle")).toBe("50%");
    expect(sounds()).toEqual([]);
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    const before = sounds().length;
    turn("0.6");
    turn("0.7");
    expect(scale().style.getPropertyValue("--needle")).toBe("66%");
    const clicks = sounds().slice(before);
    expect(clicks).toHaveLength(2);
    expect(clicks[0]).toEqual({ type: "square", hz: 1800, gain: 0.025 });
    el("power").click();
    await flush();
    const off = sounds().length;
    turn("0.8");
    expect(sounds()).toHaveLength(off);
  });

  it("the switch clicks low on ON and on OFF, at the volume", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    expect(sounds()).toEqual([{ type: "triangle", hz: 110, gain: 0.08 * 0.8 }]);
    expect(ctxs[0]!.resume).toHaveBeenCalled();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    el("power").click();
    await flush();
    expect(sounds()).toHaveLength(2);
    expect(sounds()[1]!.hz).toBe(110);
  });

  it("taps the cloud clip for the lamp, and a tap that throws still plays the clip", async () => {
    for (const throws of [false, true]) {
      tapThrows = throws;
      ctxs = [];
      audios = [];
      root.innerHTML = "";
      nextReplies = [ok({ ...epA(), cloudTts: true })];
      const s = mountStation(root, opts({ ttsUrl: "/tts" }));
      await power();
      await vi.waitFor(() => expect(audios.some((a) => a.src.startsWith("/tts?episode=epA&line=0"))).toBe(true));
      const clip = audios.find((a) => !a.loop)!;
      expect(clip.play).toHaveBeenCalled();
      expect(ctxs[0]!.tapped).toEqual(throws ? [] : [clip]);
      s.unmount();
    }
  });

  it("a thin line in the on-air row moves down the segment's lines as they are read; the letter is not restyled", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    const at = () => root.querySelector<HTMLElement>(".up-next li.now i.reading")?.style.getPropertyValue("--at");
    await vi.waitFor(() => expect(at()).toBe("0"));
    held.shift()!.onend?.();
    await vi.waitFor(() => expect(spoken).toEqual(["a1", "l1"]));
    expect(at()).toBe("1");
    expect(root.querySelectorAll(".up-next i.reading")).toHaveLength(1);
    expect(root.querySelector(".player-letter")!.className).toBe("player-letter");
  });

  it("a pressed card's picture flies to the radio once, then is gone; a second press meanwhile adds none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    HTMLElement.prototype.scrollIntoView = vi.fn() as unknown as HTMLElement["scrollIntoView"];
    nextReplies = [ok(epB()), ok(epB())];
    autoEnd = false;
    mountStation(root, opts({ stationKey: "mine" }));
    const a = document.createElement("a");
    a.href = "/stations/mine?letter=L5";
    a.setAttribute("data-play-letter", "L5");
    a.innerHTML = '<span class="letter-card-art"><img src="https://img/a.jpg" alt="" width="96" height="96" loading="lazy"></span>';
    document.body.append(a);
    const press = () => a.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    press();
    press();
    const flights = document.body.querySelectorAll("img.flight");
    expect(flights).toHaveLength(1);
    expect(flights[0]!.getAttribute("src")).toBe("https://img/a.jpg");
    expect(flights[0]!.hasAttribute("loading")).toBe(false);
    vi.advanceTimersByTime(400);
    expect(document.body.querySelector(".flight")).toBeNull();
    a.remove();
  });

  it("私も swells the pill, chimes once, and floats an envelope up from the face that goes after a second; no count", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    held.shift()!.onend?.();
    await vi.waitFor(() => expect(el("watashimo")).not.toBeNull());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    el("watashimo").click();
    await flush();
    expect(el("watashimo").className).toBe("pill hot said");
    expect(sounds().filter((p) => p.type === "sine")).toEqual([{ type: "sine", hz: 880, gain: 0.04 * 0.8 }]);
    const glyph = root.querySelector(".face .envelope.float")!;
    expect(glyph.querySelector("svg")).not.toBeNull();
    expect(glyph.textContent).toBe("");
    vi.advanceTimersByTime(1000);
    expect(root.querySelector(".face .envelope")).toBeNull();
  });

  it("a letter sent from the modal draws an envelope into the face as the modal closes", () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<section class="radio"><div class="face"></div></section><a class="button" href="/put" data-open-send>お便りを送る</a><dialog class="send-modal"><iframe data-src="/put?embed=1"></iframe></dialog>';
    const dialog = document.querySelector("dialog")!;
    const frame = document.querySelector("iframe")!;
    Object.defineProperty(frame, "contentWindow", { value: {} as Window, configurable: true });
    dialog.showModal = vi.fn() as unknown as HTMLDialogElement["showModal"];
    dialog.close = vi.fn() as unknown as HTMLDialogElement["close"];
    const unwire = wireSendModal(document);
    try {
      document.querySelector("[data-open-send]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dfm:sent" }, origin: location.origin, source: frame.contentWindow }));
      expect(document.querySelector(".envelope")).toBeNull();
      vi.advanceTimersByTime(1500);
      expect(document.querySelectorAll(".face .envelope.drawn")).toHaveLength(1);
      vi.advanceTimersByTime(1400);
      expect(document.querySelector(".envelope")).toBeNull();
    } finally {
      unwire();
    }
  });

  it("nothing flies or floats under prefers-reduced-motion", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    HTMLElement.prototype.scrollIntoView = vi.fn() as unknown as HTMLElement["scrollIntoView"];
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    const a = document.createElement("a");
    a.setAttribute("data-play-letter", "L5");
    a.innerHTML = '<img src="https://img/a.jpg" alt="">';
    document.body.append(a);
    a.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".flight")).toBeNull();
    a.remove();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    held.shift()!.onend?.();
    await vi.waitFor(() => expect(el("watashimo")).not.toBeNull());
    el("watashimo").click();
    await flush();
    expect(el("watashimo").disabled).toBe(true);
    expect(document.querySelector(".envelope")).toBeNull();
    // The sounds stay.
    expect(sounds().some((p) => p.type === "sine")).toBe(true);
  });

  it("marks the page while on air, for the home's waves", async () => {
    nextReplies = [ok(epA())];
    autoEnd = false;
    const s = mountStation(root, opts());
    expect(document.documentElement.hasAttribute("data-on-air")).toBe(false);
    await power();
    await vi.waitFor(() => expect(document.documentElement.hasAttribute("data-on-air")).toBe(true));
    el("power").click();
    await flush();
    expect(document.documentElement.hasAttribute("data-on-air")).toBe(false);
    s.unmount();
  });

  it("late at night (23:00 to 04:59 on the device) the face goes one step warmer, checked again every hour", () => {
    expect([22, 23, 0, 4, 5, 12].map((h) => isNight(new Date(2026, 10, 7, h, 30)))).toEqual([false, true, true, true, false, false]);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(2026, 10, 7, 22, 30));
    const s = mountStation(root, opts());
    expect(document.documentElement.hasAttribute("data-night")).toBe(false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(document.documentElement.hasAttribute("data-night")).toBe(true);
    s.unmount();
    expect(document.documentElement.hasAttribute("data-night")).toBe(false);
  });

  it("once unmounted, the hourly check stops and the sound context is closed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(2026, 10, 7, 22, 30));
    nextReplies = [ok(epA())];
    autoEnd = false;
    const s = mountStation(root, opts());
    await power();
    s.unmount();
    expect(ctxs[0]!.close).toHaveBeenCalled();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(document.documentElement.hasAttribute("data-night")).toBe(false);
  });

  it("the lamp loop stays idle with nothing tapped (the browser voice)", async () => {
    const frame = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", frame);
    nextReplies = [ok(epA())];
    autoEnd = false;
    mountStation(root, opts());
    await power();
    await vi.waitFor(() => expect(spoken).toEqual(["a1"]));
    expect(frame).not.toHaveBeenCalled();
  });
});
