/** @jsxImportSource hono/jsx/dom */
import { flushSync } from "hono/jsx/dom";
import { createRoot } from "hono/jsx/dom/client";
import { bindMediaSession, createLinePlayer, type LetterLine, type PlayerEpisode, type PlayerItem, syncMediaSession } from "./playback";
import { postLetter, saveDial } from "./reactions";
import { StationScreen, type UpNextRow } from "./station-view";

export type StationOptions = {
  stationKey: string;
  label: string;
  nextUrl: string;
  resumeUrl: string;
  /** When set, episodes that have a cloud voice read from `${ttsUrl}?episode=&line=`; the rest use Web Speech. */
  ttsUrl: string | null;
  voiceURI: string;
  /** The listener's dial; the world station has none and shows no dial. */
  dial?: number;
  /** A station with no history yet: show how to start, and do not fetch anything. */
  grow?: boolean;
  strings: Record<string, string>;
};

export type StationState = {
  power: "off" | "tuning" | "on" | "limit" | "failed";
  /** 0..1 */
  volume: number;
  current: PlayerEpisode | null;
  seg: number;
  line: number;
  queue: PlayerEpisode[];
};

type Reason = "limit" | "failed" | "empty";
type State = StationState & { reason: Reason | null; loading: boolean; replyOpen: boolean; sent: Record<string, true>; sendFailed: boolean };
type Fetched = { ok: true; view: PlayerEpisode } | { ok: false; reason: Reason };

const VOLUME_KEY = "dfm.volume";
const DEFAULT_VOLUME = 0.8;

function loadVolume(): number {
  try {
    const v = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  } catch {}
  return DEFAULT_VOLUME;
}

const playable = (v: unknown): v is PlayerEpisode => {
  const e = v as Partial<PlayerEpisode> | null;
  return !!e && typeof e.id === "string" && Array.isArray(e.segments) && e.segments.length > 0 && typeof e.items === "object" && e.items !== null;
};

export function mountStation(root: HTMLElement, opts: StationOptions) {
  const str = (key: string) => opts.strings[key] ?? key;
  const player = createLinePlayer({ voiceURI: opts.voiceURI, ttsUrl: opts.ttsUrl });
  const reactRoot = createRoot(root);
  let state: State = { power: "off", volume: loadVolume(), current: null, seg: 0, line: 0, queue: [], reason: null, loading: false, replyOpen: false, sent: {}, sendFailed: false };
  let abort = new AbortController();
  let mounted = true;
  /** The episode being made for the queue, if any. */
  let ahead: Promise<void> | null = null;
  /** Why the last ask for the next episode failed. `limit` is final for the day; others are tried again. */
  let aheadFail: Reason | null = null;
  let resumeTried = false;
  let starting = false;
  player.setVolume(state.volume);

  const itemOf = (ep: PlayerEpisode | null, seg: number): PlayerItem | undefined => {
    const id = ep?.segments[seg]?.itemId;
    return id === undefined ? undefined : ep?.items[id];
  };

  function setState(patch: Partial<State>) {
    if (!mounted) return;
    const was = state;
    state = { ...state, ...patch };
    flushSync(() => reactRoot.render(<StationScreen {...screenProps()} />));
    if (was.current !== state.current || was.seg !== state.seg || was.power !== state.power) syncMediaSession(itemOf(state.current, state.seg), state.power === "on");
  }

  async function requestNext(): Promise<Fetched> {
    try {
      const res = await fetch(opts.nextUrl, { method: "POST" });
      if (res.status === 429) return { ok: false, reason: "limit" };
      if (res.status === 409) return { ok: false, reason: "empty" };
      if (!res.ok) return { ok: false, reason: "failed" };
      const body = (await res.json()) as { episode?: unknown };
      return playable(body.episode) ? { ok: true, view: body.episode } : { ok: false, reason: "failed" };
    } catch {
      return { ok: false, reason: "failed" };
    }
  }

  /** The listener's latest episode, to pick up where the last visit left off; null when there is none or it cannot be read. */
  async function requestResume(): Promise<PlayerEpisode | null> {
    try {
      const res = await fetch(opts.resumeUrl);
      if (res.status !== 200) return null;
      const body = (await res.json()) as { episode?: unknown };
      return playable(body.episode) ? body.episode : null;
    } catch {
      return null;
    }
  }

  /** Makes the next episode in the background so it is ready when this one ends. One at a time, one deep. */
  function ensureAhead(): Promise<void> {
    if (ahead) return ahead;
    if (state.queue.length > 0 || aheadFail === "limit") return Promise.resolve();
    aheadFail = null;
    ahead = requestNext().then((r) => {
      ahead = null;
      if (r.ok) setState({ queue: [...state.queue, r.view] });
      else aheadFail = r.reason;
    });
    return ahead;
  }

  /** The current episode is done: go on with the queued one, or stop with the reason there is none. */
  async function advance(signal: AbortSignal): Promise<boolean> {
    player.stopBed();
    if (state.queue.length === 0) {
      setState({ loading: true });
      await ensureAhead();
      if (signal.aborted) return false;
    }
    const [head, ...rest] = state.queue;
    if (head) {
      setState({ current: head, seg: 0, line: 0, queue: rest, loading: false, replyOpen: false });
      return true;
    }
    const reason = aheadFail ?? "failed";
    setState({ power: reason === "limit" ? "limit" : "failed", reason, loading: false });
    return false;
  }

  async function run(signal: AbortSignal) {
    while (!signal.aborted) {
      const ep = state.current;
      if (!ep) return;
      const [startSeg, startLine] = [state.seg, state.line];
      for (let i = startSeg; i < ep.segments.length; i++) {
        if (i >= Math.max(0, ep.segments.length - 2)) void ensureAhead();
        const lines = ep.segments[i]!.lines;
        for (let j = i === startSeg ? startLine : 0; j < lines.length; j++) {
          if (signal.aborted) return;
          if (i !== state.seg || j !== state.line) setState({ seg: i, line: j, replyOpen: false });
          await player.play(ep, i, j, signal);
        }
      }
      if (signal.aborted) return;
      if (!(await advance(signal))) return;
    }
  }

  /** The first episode after the switch is turned on: where the last visit stopped, else a new one. */
  async function begin() {
    starting = true;
    let view: PlayerEpisode | null = null;
    let reason: Reason | null = null;
    if (!resumeTried) {
      resumeTried = true;
      view = await requestResume();
    }
    if (!view) {
      const r = await requestNext();
      if (r.ok) view = r.view;
      else reason = r.reason;
    }
    starting = false;
    if (!view) {
      if (state.power !== "off") setState({ power: reason === "limit" ? "limit" : "failed", reason });
      return;
    }
    // Kept even if the switch went off meanwhile: the episode is made, and turning on again plays it.
    setState({ current: view, seg: 0, line: 0 });
    if (state.power === "off") return;
    setState({ power: "on" });
    void run(abort.signal);
  }

  function turnOn() {
    if (state.power === "on" || state.power === "tuning" || opts.grow) return;
    player.unlock();
    abort.abort();
    abort = new AbortController();
    const finished = state.power === "limit" || state.power === "failed";
    if (finished) {
      aheadFail = null;
      setState({ current: null, seg: 0, line: 0 });
    }
    if (state.current) {
      setState({ power: "on", reason: null, loading: false });
      void run(abort.signal);
    } else {
      setState({ power: "tuning", reason: null, loading: false });
      if (!starting) void begin();
    }
  }

  function turnOff() {
    if (state.power === "off") return;
    abort.abort();
    player.stopBed();
    setState({ power: "off", loading: false });
  }

  /** Lock-screen "next": skip to the next work, or to the next episode from the last one. */
  function skip() {
    const ep = state.current;
    if (state.power !== "on" || !ep) return;
    abort.abort();
    abort = new AbortController();
    if (state.seg + 1 < ep.segments.length) setState({ seg: state.seg + 1, line: 0, replyOpen: false });
    else setState({ line: ep.segments[state.seg]!.lines.length });
    void run(abort.signal);
  }

  function setVolume(volume: number) {
    const v = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : DEFAULT_VOLUME));
    player.setVolume(v);
    try {
      localStorage.setItem(VOLUME_KEY, String(v));
    } catch {}
    setState({ volume: v });
  }

  async function send(fields: Record<string, string>, key: string) {
    if (await postLetter(fields)) setState({ sent: { ...state.sent, [key]: true }, replyOpen: false, sendFailed: false });
    else setState({ sendFailed: true });
  }

  const lineNow = () => state.current?.segments[state.seg]?.lines[state.line];
  const letterNow = (): LetterLine | null => {
    const l = lineNow();
    return l?.type === "letter" ? l : null;
  };

  function upNextRows(): UpNextRow[] {
    const rows: UpNextRow[] = [];
    const add = (ep: PlayerEpisode, from: number) => {
      ep.segments.slice(from).forEach((s, n) => {
        const item = ep.items[s.itemId];
        if (item) rows.push({ key: `${ep.id}:${from + n}`, kind: item.kind ?? null, title: item.title, creator: item.creator });
      });
    };
    if (state.current) add(state.current, state.seg + 1);
    for (const ep of state.queue) add(ep, 0);
    return rows;
  }

  function screenProps() {
    const letter = letterNow();
    const line = lineNow();
    return {
      str,
      power: state.power,
      loading: state.loading,
      reason: state.reason,
      sendFailed: state.sendFailed,
      volume: state.volume,
      dial: opts.stationKey === "world" ? null : (opts.dial ?? 0.3),
      grow: opts.grow === true,
      item: itemOf(state.current, state.seg),
      itemId: state.current?.segments[state.seg]?.itemId,
      letter,
      original: letter ? state.current?.originals?.[letter.letterId] : undefined,
      djText: line?.type === "dj" ? line.text : null,
      upNext: upNextRows(),
      replyOpen: state.replyOpen,
      sent: state.sent,
      on: {
        power: () => (state.power === "on" || state.power === "tuning" ? turnOff() : turnOn()),
        volume: setVolume,
        dial: saveDial,
        toggleReply: () => setState({ replyOpen: !state.replyOpen }),
        watashimo() {
          const itemId = state.current?.segments[state.seg]?.itemId;
          const l = letterNow();
          if (l && itemId) void send({ kind: "watashimo", itemId, parentLetterId: l.letterId }, `w:${l.letterId}`);
        },
        reply(body: string) {
          const itemId = state.current?.segments[state.seg]?.itemId;
          const l = letterNow();
          if (l && itemId && body.trim() !== "") void send({ kind: "reply", body, itemId, parentLetterId: l.letterId }, `r:${l.letterId}`);
        },
      },
    };
  }

  bindMediaSession({ play: turnOn, pause: turnOff, next: skip });
  setState({});

  return {
    state: (): StationState => state,
    unmount() {
      mounted = false;
      abort.abort();
      player.stopBed();
      reactRoot.unmount();
    },
  };
}

function boot() {
  const el = document.getElementById("station");
  if (!el) return;
  const strings = JSON.parse(document.getElementById("station-i18n")?.textContent ?? "{}") as Record<string, string>;
  const dial = Number.parseFloat(el.dataset.dial ?? "");
  mountStation(el, {
    stationKey: el.dataset.stationKey ?? "world",
    label: el.dataset.label ?? "",
    nextUrl: el.dataset.nextUrl ?? "",
    resumeUrl: el.dataset.resumeUrl ?? "",
    ttsUrl: el.dataset.ttsUrl ? el.dataset.ttsUrl : null,
    voiceURI: el.dataset.voice ?? "",
    ...(Number.isFinite(dial) ? { dial } : {}),
    grow: el.dataset.grow === "1",
    strings,
  });
}

if (typeof document !== "undefined") boot();
