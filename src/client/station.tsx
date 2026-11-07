/** @jsxImportSource hono/jsx/dom */
import { flushSync } from "hono/jsx/dom";
import { createRoot } from "hono/jsx/dom/client";
import { bindMediaSession, createLinePlayer, fetchNext, type LetterLine, type PlayerEpisode, type PlayerItem, reportListen, resumeAt, type StoredPosition, syncMediaSession, whoOf } from "./playback";
import { loadDial, postLetter, reactionOf, storeDial } from "./reactions";
import { StationScreen, type UpNextRow } from "./station-view";

export type StationOptions = {
  stationKey: string;
  label: string;
  nextUrl: string;
  resumeUrl: string;
  /** When set, episodes that have a cloud voice read from `${ttsUrl}?episode=&line=`; the rest use Web Speech. */
  ttsUrl: string | null;
  /** Where a letter that starts playing is reported (`POST`, JSON); absent means nothing is recorded. */
  listensUrl?: string;
  voiceURI: string;
  /** The dial the page suggests (the signed-in listener's); the browser's own value wins. World and public stations show no dial. */
  dial?: number;
  /** A letter the listener came to hear: the first ask of this visit carries it, and only that one. */
  letterId?: string;
  /** A station with no history yet: show how to start, and do not fetch anything. */
  grow?: boolean;
  /** The home: show the send button above the on-air list. */
  send?: boolean;
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
const POS_KEY = "dfm.pos:";
const DEFAULT_VOLUME = 0.8;
/** A turn of the dial is sent once it rests this long, so a sweep is one new ask, not many. */
const DIAL_SETTLE_MS = 300;
const TOAST_MS = 2500;
const HINT_KEY = "dfm.dialHinted";
/** Set at the first switch-on; the home then shows its hero short (wordmark and tagline only) on later visits. */
const SEEN_KEY = "dfm.seen";

function loadVolume(): number {
  try {
    const v = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  } catch {}
  return DEFAULT_VOLUME;
}

/** Where this browser left off on a station: the episode being played, its segment and line, and that segment's first letter. */
type Position = StoredPosition & { episodeId: string };

const loadPosition = (stationKey: string): Position | null => {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY + stationKey) ?? "null") as Partial<Position> | null;
    if (p && typeof p.episodeId === "string" && p.episodeId !== "" && Number.isInteger(p.seg) && Number.isInteger(p.line) && p.seg! >= 0 && p.line! >= 0 && (p.letterId === undefined || typeof p.letterId === "string")) return p as Position;
  } catch {}
  return null;
};

const savePosition = (stationKey: string, p: Position) => {
  try {
    localStorage.setItem(POS_KEY + stationKey, JSON.stringify(p));
  } catch {}
};

const playable = (v: unknown): v is PlayerEpisode => {
  const e = v as Partial<PlayerEpisode> | null;
  return !!e && typeof e.id === "string" && Array.isArray(e.segments) && e.segments.length > 0 && typeof e.items === "object" && e.items !== null;
};

/** A left click no one has handled and without a modifier: one that would follow the link in this tab. */
const plainClick = (e: MouseEvent): boolean => !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function mountStation(root: HTMLElement, opts: StationOptions) {
  const str = (key: string) => opts.strings[key] ?? key;
  const player = createLinePlayer({ voiceURI: opts.voiceURI, ttsUrl: opts.ttsUrl, lang: str("lang.code") === "en" ? "en" : "ja" });
  const reactRoot = createRoot(root);
  let state: State = { power: "off", volume: loadVolume(), current: null, seg: 0, line: 0, queue: [], reason: null, loading: false, replyOpen: false, sent: {}, sendFailed: false };
  let abort = new AbortController();
  let mounted = true;
  /** The episode being made for the queue, if any. */
  let ahead: Promise<void> | null = null;
  /** Why the last ask for the next episode failed. `limit` holds until the switch or a card asks again; others are tried again. */
  let aheadFail: Reason | null = null;
  let resumeTried = false;
  let starting = false;
  /** Bumped when a card restarts the radio: a start already under way is dropped. */
  let starts = 0;
  let dial = loadDial(opts.dial);
  let dialTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped when the dial turns: an ask made before that no longer fits and its answer is dropped. */
  let generation = 0;
  /** Something has played or been resumed on this visit, so the DJ does not open again. */
  let heard = false;
  let hinted = false;
  let letterId = opts.letterId;
  player.setVolume(state.volume);

  /** One `div.toast` at a time: a new message replaces the last, and it goes away after 2.5 s. */
  let toastEl: HTMLElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(text: string) {
    if (!mounted) return;
    toastEl?.remove();
    clearTimeout(toastTimer);
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    toastEl.setAttribute("role", "status");
    toastEl.textContent = text;
    document.body.append(toastEl);
    toastTimer = setTimeout(() => {
      toastEl?.remove();
      toastEl = null;
    }, TOAST_MS);
  }
  /** Once per session, the first time the dial rests: a turn only counts from the next letter. */
  function hintDial() {
    try {
      if (sessionStorage.getItem(HINT_KEY)) return;
      sessionStorage.setItem(HINT_KEY, "1");
    } catch {
      if (hinted) return;
    }
    hinted = true;
    toast(str("station.dialHint"));
  }

  const itemOf = (ep: PlayerEpisode | null, seg: number): PlayerItem | undefined => {
    const id = ep?.segments[seg]?.itemId;
    return id === undefined ? undefined : ep?.items[id];
  };

  function setState(patch: Partial<State>) {
    if (!mounted) return;
    const was = state;
    state = { ...state, ...patch };
    flushSync(() => reactRoot.render(<StationScreen {...screenProps()} />));
    if (state.current && (was.current !== state.current || was.seg !== state.seg || was.line !== state.line)) {
      const letterId = state.current.segments[state.seg]?.lines.find((l): l is LetterLine => l.type === "letter")?.letterId;
      savePosition(opts.stationKey, { episodeId: state.current.id, seg: state.seg, line: state.line, ...(letterId ? { letterId } : {}) });
    }
    if (was.current !== state.current || was.seg !== state.seg || was.power !== state.power) syncMediaSession(itemOf(state.current, state.seg), state.power === "on");
  }

  /** Asks for the next episode. The asked letter rides every ask until one is answered and used (see `begin`, `ensureAhead`). */
  async function requestNext(): Promise<Fetched> {
    const r = await fetchNext(opts.nextUrl, { dial, first: !heard, ...(letterId ? { letterId } : {}) });
    if (!r.ok) return r;
    const episode = r.body.episode;
    return playable(episode) ? { ok: true, view: episode } : { ok: false, reason: "failed" };
  }

  /**
   * The episode this browser was playing, or else the listener's latest on this station (from its beginning); null when there is none,
   * or it cannot be read; also null when the stored one was played to its end and no later one is made.
   */
  async function requestResume(): Promise<{ view: PlayerEpisode; seg: number; line: number } | null> {
    const stored = loadPosition(opts.stationKey);
    const read = async (url: string): Promise<PlayerEpisode | null> => {
      try {
        const res = await fetch(url);
        if (res.status !== 200) return null;
        const body = (await res.json()) as { episode?: unknown };
        return playable(body.episode) ? body.episode : null;
      } catch {
        return null;
      }
    };
    if (stored) {
      const view = await read(`${opts.resumeUrl}?id=${encodeURIComponent(stored.episodeId)}`);
      if (view) {
        const at = resumeAt(view, stored);
        if (at) return { view, ...at };
        // Played to its end: the next one may already be made (a prefetch); if it is not, a new one is.
        const latest = await read(opts.resumeUrl);
        return latest && latest.id !== view.id ? { view: latest, seg: 0, line: 0 } : null;
      }
    }
    const view = await read(opts.resumeUrl);
    return view ? { view, seg: 0, line: 0 } : null;
  }

  /** Makes the next episode in the background so it is ready when this one ends. One at a time, one deep. */
  function ensureAhead(): Promise<void> {
    if (ahead) return ahead;
    if (state.queue.length > 0 || aheadFail === "limit") return Promise.resolve();
    aheadFail = null;
    const asked = generation;
    const p = requestNext().then((r) => {
      if (asked !== generation) return;
      ahead = null;
      if (r.ok) {
        letterId = undefined;
        setState({ queue: [...state.queue, r.view] });
      } else aheadFail = r.reason;
    });
    ahead = p;
    return p;
  }

  /** The dial turned: keep it, and once it rests, forget the episode made with the old value and ask again. */
  function turnDial(value: string) {
    const v = storeDial(value);
    if (v === null) return;
    dial = v;
    hintDial();
    setState({});
    clearTimeout(dialTimer);
    dialTimer = setTimeout(() => {
      if (!mounted) return;
      generation++;
      ahead = null;
      if (aheadFail !== "limit") aheadFail = null;
      setState({ queue: [] });
      if (state.power === "on") void ensureAhead();
    }, DIAL_SETTLE_MS);
  }

  /** The current episode is done: go on with the queued one, or stop with the reason there is none. */
  async function advance(signal: AbortSignal): Promise<boolean> {
    player.stopBed();
    if (state.queue.length === 0) {
      setState({ loading: true });
      // A turn of the dial drops the ask being awaited and starts another: wait for that one instead.
      do {
        await ensureAhead();
        if (signal.aborted) return false;
      } while (state.queue.length === 0 && ahead !== null);
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
          const line = lines[j]!;
          if (opts.listensUrl && line.type === "letter" && line.kind !== "reply") reportListen(opts.listensUrl, { episodeId: ep.id, letterId: line.letterId, segmentIndex: i });
          await player.play(ep, i, j, signal);
        }
      }
      if (signal.aborted) return;
      // The episode is done: if the switch goes off while the next one is awaited, turning on must not read the last line again.
      setState({ line: ep.segments[state.seg]!.lines.length });
      if (!(await advance(signal))) return;
    }
  }

  /** The first episode after the switch is turned on: where the last visit stopped, else a new one. */
  async function begin() {
    starting = true;
    // A card pressed while this start awaits takes over: this one then stops at its next step.
    const start = starts;
    let view: PlayerEpisode | null = null;
    let [seg, line] = [0, 0];
    let reason: Reason | null = null;
    // A letter link plays the asked letter first: the last visit is not resumed.
    if (!resumeTried) {
      resumeTried = true;
      const resumed = letterId ? null : await requestResume();
      if (start !== starts) return;
      if (resumed) ({ view, seg, line } = resumed);
    }
    if (!view) {
      const r = await requestNext();
      if (start !== starts) return;
      if (r.ok) {
        view = r.view;
        letterId = undefined;
      } else reason = r.reason;
    }
    if (view) heard = true;
    starting = false;
    if (!view) {
      if (state.power !== "off") setState({ power: reason === "limit" ? "limit" : "failed", reason });
      return;
    }
    // Kept even if the switch went off meanwhile: the episode is made, and turning on again plays it.
    setState({ current: view, seg, line });
    if (state.power === "off") return;
    setState({ power: "on" });
    void run(abort.signal);
  }

  function turnOn() {
    if (state.power === "on" || state.power === "tuning" || opts.grow) return;
    player.unlock();
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {}
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

  /** A letter card on the page: start again from that letter, as a new visit would (no resume, `first` with the letter). */
  function playLetter(id: string) {
    abort.abort();
    player.stopBed();
    generation++;
    starts++;
    ahead = null;
    // A press is a fresh ask, even after the day's limit: the tab may have been open past midnight JST.
    aheadFail = null;
    letterId = id;
    heard = false;
    resumeTried = true;
    starting = false;
    setState({ power: "off", current: null, seg: 0, line: 0, queue: [], loading: false });
    turnOn();
    toast(str("station.playFromToast"));
    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** Cards keep their link for a new tab or no script; a plain click plays the letter here. */
  function onCardClick(e: MouseEvent) {
    const card = (e.target as Element | null)?.closest?.("[data-play-letter]");
    const id = card?.getAttribute("data-play-letter");
    if (!id || opts.grow || !root.isConnected || !plainClick(e)) return;
    e.preventDefault();
    playLetter(id);
  }

  /** The header's language switch reloads the page and so stops the radio: ask first, but only while it is on. */
  function onLangSubmit(e: Event) {
    const form = e.target as Element | null;
    if (!root.isConnected || !form?.hasAttribute?.("data-confirm") || (state.power !== "on" && state.power !== "tuning")) return;
    if (!confirm(str("lang.confirmPlaying"))) e.preventDefault();
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

  /** Reactions on their way, so a second tap before the answer does not post twice. */
  const sending = new Set<string>();
  /** True when the post was taken. `fromPlayer` closes the player card's reply input; the panel has its own. */
  async function send(fields: Record<string, string>, key: string, fromPlayer: boolean): Promise<boolean> {
    if (sending.has(key)) return false;
    sending.add(key);
    const taken = await postLetter(fields);
    sending.delete(key);
    if (taken && key.startsWith("w:")) toast(str("player.sentToast"));
    if (taken) setState({ sent: { ...state.sent, [key]: true }, ...(fromPlayer ? { replyOpen: false } : {}), sendFailed: false });
    else setState({ sendFailed: true });
    return taken;
  }

  /** The player card reacts to the letter being read; the on-air row names the segment's first letter (`panelLetterId`). */
  function react(kind: "watashimo" | "reply", body?: string, panelLetterId?: string): Promise<boolean> {
    const r = reactionOf(kind, state.current?.segments[state.seg]?.itemId, panelLetterId ?? letterNow()?.letterId, body);
    return r ? send(r.fields, r.key, panelLetterId === undefined) : Promise.resolve(false);
  }

  const lineNow = () => state.current?.segments[state.seg]?.lines[state.line];
  const letterNow = (): LetterLine | null => {
    const l = lineNow();
    return l?.type === "letter" ? l : null;
  };

  function upNextRows(): UpNextRow[] {
    const rows: UpNextRow[] = [];
    const add = (ep: PlayerEpisode, from: number, upto: number, now = false) => {
      ep.segments.slice(from, upto).forEach((s, n) => {
        const item = ep.items[s.itemId];
        if (!item) return;
        const first = s.lines.find((l): l is LetterLine => l.type === "letter");
        rows.push({ key: `${ep.id}:${from + n}`, now, kind: item.kind ?? null, title: item.title, creator: item.creator, ...(first ? { sender: whoOf(first, str) } : {}), ...(now && first ? { letterId: first.letterId } : {}), ...(now ? { imageUrl: item.imageUrl } : {}) });
      });
    };
    // Off, limit and failed: the panel is empty and shows its hint, so nothing stale is listed.
    if (state.power !== "on" && state.power !== "tuning") return rows;
    // Between episodes nothing is on air yet: only what is queued.
    if (state.power === "on" && !state.loading && state.current) {
      add(state.current, state.seg, state.seg + 1, true);
      add(state.current, state.seg + 1, Infinity);
    }
    for (const ep of state.queue) add(ep, 0, Infinity);
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
      dial: opts.stationKey === "mine" ? dial : null,
      grow: opts.grow === true,
      send: opts.send === true,
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
        dial: turnDial,
        toggleReply: () => setState({ replyOpen: !state.replyOpen }),
        watashimo: (letterId?: string) => void react("watashimo", undefined, letterId),
        reply: (body: string, letterId?: string) => react("reply", body, letterId),
      },
    };
  }

  bindMediaSession({ play: turnOn, pause: turnOff, next: skip });
  document.addEventListener("click", onCardClick);
  document.addEventListener("submit", onLangSubmit);
  setState({});

  return {
    state: (): StationState => state,
    unmount() {
      mounted = false;
      clearTimeout(dialTimer);
      clearTimeout(toastTimer);
      toastEl?.remove();
      document.removeEventListener("click", onCardClick);
      document.removeEventListener("submit", onLangSubmit);
      abort.abort();
      player.stopBed();
      reactRoot.unmount();
    },
  };
}

/**
 * The home's send modal: the button (drawn by this script, above the on-air list; without script the way to `/put` is the header's link) opens the `<dialog>`, whose frame loads `/put?embed=1`
 * on the first open and again after a letter is sent. The embedded sent page posts `dfm:sent`, which closes it after
 * `SENT_CLOSE_MS` so its confirmation is seen; Escape inside
 * the frame posts `dfm:close`; a message from any other origin or any other window is ignored. Escape on the page and the close button close it natively.
 */
/** How long the send modal stays open on its 「届きました」 page before it closes. */
const SENT_CLOSE_MS = 1500;

export function wireSendModal(doc: Document = document): () => void {
  const dialog = doc.querySelector<HTMLDialogElement>("dialog.send-modal");
  const frame = dialog?.querySelector("iframe");
  if (!dialog || !frame || typeof dialog.showModal !== "function") return () => {};
  let fresh = false;
  let closing: ReturnType<typeof setTimeout> | undefined;
  const open = (e: MouseEvent) => {
    if (!(e.target as Element | null)?.closest?.("[data-open-send]") || !plainClick(e)) return;
    e.preventDefault();
    clearTimeout(closing);
    if (!fresh) frame.src = frame.dataset.src ?? "/put?embed=1";
    fresh = true;
    dialog.showModal();
  };
  /** `dfm:sent` closes and reloads the frame next time; `dfm:close` (Escape inside the frame) closes and keeps what was typed. */
  const sent = (e: MessageEvent) => {
    const type = (e.data as { type?: unknown } | null)?.type;
    // Same origin is not enough: another tab or frame of this site could hold a reference to the home.
    if (e.origin !== location.origin || !frame.contentWindow || e.source !== frame.contentWindow || (type !== "dfm:sent" && type !== "dfm:close")) return;
    clearTimeout(closing);
    if (type === "dfm:close") return dialog.close();
    fresh = false;
    closing = setTimeout(() => dialog.close(), SENT_CLOSE_MS);
  };
  doc.addEventListener("click", open);
  window.addEventListener("message", sent);
  return () => {
    clearTimeout(closing);
    doc.removeEventListener("click", open);
    window.removeEventListener("message", sent);
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
    ...(el.dataset.listensUrl ? { listensUrl: el.dataset.listensUrl } : {}),
    voiceURI: el.dataset.voice ?? "",
    ...(Number.isFinite(dial) ? { dial } : {}),
    ...(el.dataset.letter ? { letterId: el.dataset.letter } : {}),
    grow: el.dataset.grow === "1",
    send: el.dataset.send === "1",
    strings,
  });
}

if (typeof document !== "undefined") {
  boot();
  wireSendModal();
}
