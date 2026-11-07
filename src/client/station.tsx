/** @jsxImportSource hono/jsx/dom */
import { flushSync } from "hono/jsx/dom";
import { createRoot } from "hono/jsx/dom/client";
import { bindMediaSession, createLinePlayer, fetchNext, fmt, type LetterLine, type PlayerEpisode, type PlayerItem, reportListen, resumeAt, type StoredPosition, syncMediaSession, whoOf } from "./playback";
import { shareText } from "../views/share";
import { loadDial, reactionOf, sendLetter, storeDial } from "./reactions";
import { clearToast, toast as showToast, wireShare } from "./share";
import { createSounds } from "./sounds";
import { StationScreen, type UpNextRow } from "./station-view";
import { startTour, tourDone } from "./tour";

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
  /** The home: show the send panel above the on-air list. */
  send?: boolean;
  /** The listener has no radio name: the 一言 form offers to add one, until a reply carries it. */
  askName?: boolean;
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
type State = StationState & { reason: Reason | null; loading: boolean; sent: Record<string, true>; sendFailed: string | null; askName: boolean };
type Fetched = { ok: true; view: PlayerEpisode } | { ok: false; reason: Reason };

const VOLUME_KEY = "dfm.volume";
const POS_KEY = "dfm.pos:";
const DEFAULT_VOLUME = 0.8;
/** A turn of the dial is sent once it rests this long, so a sweep is one new ask, not many. */
const DIAL_SETTLE_MS = 300;
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

/** Under `prefers-reduced-motion` nothing moves (the sounds stay). */
const still = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 23:00 to 04:59 on the device's clock: the face's lamp colour goes one step warmer. */
export const isNight = (d: Date): boolean => d.getHours() >= 23 || d.getHours() < 5;
const NIGHT_CHECK_MS = 60 * 60 * 1000;
const markNight = () => document.documentElement.toggleAttribute("data-night", isNight(new Date()));

const ENVELOPE = '<svg viewBox="0 0 24 16" aria-hidden="true"><path pathLength="1" d="M1.5 1.5h21v13h-21zM1.5 1.5 12 9l10.5-7.5"/></svg>';
/** `float` rises from the face after a 私も; `drawn` is drawn into it after a letter is sent. How long each stays. */
const GLYPH_MS = { float: 1000, drawn: 1400 } as const;

/** One envelope of a kind at a time on the radio's face; none under reduced motion. No count, nothing to read. */
export function envelope(doc: Document, kind: keyof typeof GLYPH_MS) {
  const face = doc.querySelector(".radio .face");
  if (!face || still()) return;
  face.querySelector(`.envelope.${kind}`)?.remove();
  const g = doc.createElement("span");
  g.className = `envelope ${kind}`;
  g.innerHTML = ENVELOPE;
  face.append(g);
  setTimeout(() => g.remove(), GLYPH_MS[kind]);
}

/** A left click no one has handled and without a modifier: one that would follow the link in this tab. */
const plainClick = (e: MouseEvent): boolean => !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * The tour's parts, in the owner's order (2026-11-07): what works without an account first, sign-in last. The now-playing card shows
 * only while a letter plays: until then its step rings the on-air heading (the first match in the page's order wins).
 */
const TOUR = [".radio .control", ".knob-dial", ".now, .on-air h2", ".on-air"];
const SIGNIN = '.site-header a[href^="/auth/google"]';

export function mountStation(root: HTMLElement, opts: StationOptions) {
  const str = (key: string) => opts.strings[key] ?? key;
  const sounds = createSounds(() => breathe());
  const player = createLinePlayer({ voiceURI: opts.voiceURI, ttsUrl: opts.ttsUrl, lang: str("lang.code") === "en" ? "en" : "ja", onClip: (el) => sounds.listen(el) });
  const reactRoot = createRoot(root);
  let state: State = { power: "off", volume: loadVolume(), current: null, seg: 0, line: 0, queue: [], reason: null, loading: false, sent: {}, sendFailed: null, askName: opts.askName === true };
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

  /** The page's one toast (see `share.ts`); none once the radio is unmounted. */
  const toast = (text: string) => mounted && showToast(text);
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
    if (was.power !== state.power) {
      // The home's key visual sways its waves while the radio is on.
      document.documentElement.toggleAttribute("data-on-air", state.power === "on");
      breathe();
    }
  }

  /**
   * While on air, the ON AIR lamp follows the loudness of the cloud voice (±15 %). The loop runs only while a tapped clip plays:
   * it stops at the first frame with nothing to read, and the clip's next `play` (or the switch) starts it again.
   */
  let lampFrame = 0;
  let breathing = false;
  function breathe() {
    if (breathing || state.power !== "on" || sounds.level() === null || typeof requestAnimationFrame !== "function") return;
    breathing = true;
    const step = () => {
      const level = mounted && state.power === "on" && !still() ? sounds.level() : null;
      const lamp = root.querySelector<HTMLElement>(".face .live");
      if (level === null) {
        lamp?.style.removeProperty("--voice");
        breathing = false;
        return;
      }
      lamp?.style.setProperty("--voice", (0.85 + 0.3 * level).toFixed(2));
      lampFrame = requestAnimationFrame(step);
    };
    lampFrame = requestAnimationFrame(step);
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
    // A queued episode follows at once and its bed crosses this one; only a wait for one stops the bed.
    if (state.queue.length === 0) {
      player.stopBed();
      setState({ loading: true });
      // A turn of the dial drops the ask being awaited and starts another: wait for that one instead.
      do {
        await ensureAhead();
        if (signal.aborted) return false;
      } while (state.queue.length === 0 && ahead !== null);
    }
    const [head, ...rest] = state.queue;
    if (head) {
      setState({ current: head, seg: 0, line: 0, queue: rest, loading: false });
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
          if (i !== state.seg || j !== state.line) setState({ seg: i, line: j });
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
    // The context first: the clip element made by the player's unlock is tapped in it.
    sounds.unlock();
    player.unlock();
    sounds.play("switch", state.volume);
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
    sounds.play("switch", state.volume);
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

  /** The card's picture flies to the radio (FLIP, 300 ms), one at a time. The radio is scrolled to the top meanwhile, so it aims where the face will be. */
  let flight: HTMLElement | null = null;
  function fly(card: Element) {
    const img = card.querySelector("img");
    const face = root.querySelector(".radio .face");
    if (!img || !face || flight || still()) return;
    const from = img.getBoundingClientRect();
    const to = face.getBoundingClientRect();
    const max = document.documentElement.scrollHeight - innerHeight - scrollY;
    const shift = Math.min(Math.max(root.getBoundingClientRect().top, -scrollY), Math.max(0, max));
    const clone = img.cloneNode() as HTMLElement;
    clone.className = "flight";
    clone.removeAttribute("loading");
    Object.assign(clone.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(clone);
    flight = clone;
    const size = 40;
    const scale = from.width > 0 ? size / from.width : 1;
    const dx = to.left + (to.width - size) / 2 - from.left;
    const dy = to.top - shift + (to.height - size) / 2 - from.top;
    const land = () => {
      clone.remove();
      if (flight === clone) flight = null;
    };
    clone.addEventListener("transitionend", land, { once: true });
    setTimeout(land, 400);
    requestAnimationFrame(() => {
      clone.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      clone.style.opacity = "0.4";
    });
  }

  /** Cards keep their link for a new tab or no script; a plain click plays the letter here. */
  function onCardClick(e: MouseEvent) {
    const card = (e.target as Element | null)?.closest?.("[data-play-letter]");
    const id = card?.getAttribute("data-play-letter");
    if (!id || opts.grow || !root.isConnected || !plainClick(e)) return;
    e.preventDefault();
    fly(card!);
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
    if (state.seg + 1 < ep.segments.length) setState({ seg: state.seg + 1, line: 0 });
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
  /**
   * True when the post was taken. A reply that carried a radio name named the listener: the form stops asking. A refused name or place
   * (the region of another country, a contact in the name) says so; anything else is the plain failure.
   */
  async function send(fields: Record<string, string>, key: string): Promise<boolean> {
    if (sending.has(key)) return false;
    sending.add(key);
    const answer = await sendLetter(fields);
    const taken = answer === "taken";
    sending.delete(key);
    if (taken && key.startsWith("w:")) {
      toast(str("player.sentToast"));
      if (state.power === "on") sounds.play("watashimo", state.volume);
    }
    if (taken) setState({ sent: { ...state.sent, [key]: true }, sendFailed: null, ...(fields.radioName ? { askName: false } : {}) });
    else setState({ sendFailed: answer === "invalid" && (fields.radioName || fields.placeCountry) ? "reply.invalidName" : "player.sendFailed" });
    if (taken && key.startsWith("w:")) envelope(document, "float");
    return taken;
  }

  /** The now-playing card reacts to the segment's first letter (the on-air row's `letterId`). */
  function react(kind: "watashimo" | "reply", letterId: string, body?: string, profile: Record<string, string> = {}): Promise<boolean> {
    const r = reactionOf(kind, state.current?.segments[state.seg]?.itemId, letterId, body);
    return r ? send({ ...r.fields, ...profile }, r.key) : Promise.resolve(false);
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
        const reading = s.lines.length > 1 ? Math.min(1, state.line / (s.lines.length - 1)) : 0;
        rows.push({ key: `${ep.id}:${from + n}`, now, kind: item.kind ?? null, title: item.title, creator: item.creator, ...(first ? { sender: whoOf(first, str) } : {}), ...(now && first ? { letterId: first.letterId, shareable: first.kind !== "reply" && first.kind !== "watashimo", shareText: shareText(item.title, first, (k, p) => fmt(str(k), p ?? {})) } : {}), ...(now ? { imageUrl: item.imageUrl, reading } : {}) });
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
      primed: letterId !== undefined,
      send: opts.send === true,
      item: itemOf(state.current, state.seg),
      itemId: state.current?.segments[state.seg]?.itemId,
      letter,
      original: letter ? state.current?.originals?.[letter.letterId] : undefined,
      djText: line?.type === "dj" ? line.text : null,
      upNext: upNextRows(),
      askName: state.askName,
      sent: state.sent,
      on: {
        power: () => (state.power === "on" || state.power === "tuning" ? turnOff() : turnOn()),
        volume: setVolume,
        dial: turnDial,
        tick: () => {
          if (state.power === "on" || state.power === "tuning") sounds.play("dial", state.volume);
        },
        watashimo: (letterId: string) => void react("watashimo", letterId),
        reply: (body: string, letterId: string, profile?: Record<string, string>) => react("reply", letterId, body, profile),
        tour,
      },
    };
  }

  /** The home's tour; the last step is the sign-in link, or the send panel for a listener already signed in. */
  let endTour = () => {};
  function tour() {
    const signedOut = document.querySelector(SIGNIN) !== null;
    const steps = [...TOUR, signedOut ? SIGNIN : ".send-panel"].map((at, n) => {
      const id = `station.tour${n + 1}${n === 4 && !signedOut ? "In" : ""}`;
      return { at, title: str(`${id}Title`), text: str(id) };
    });
    endTour = startTour(steps, { next: str("station.tourNext"), end: str("station.tourEnd"), skip: str("station.tourSkip"), label: str("station.tour") });
  }

  bindMediaSession({ play: turnOn, pause: turnOff, next: skip });
  document.addEventListener("click", onCardClick);
  document.addEventListener("submit", onLangSubmit);
  markNight();
  const nightTimer = setInterval(markNight, NIGHT_CHECK_MS);
  setState({});
  // A first visit to the home, or `/?tour=1` (the about page's 「使い方」); never over the send modal. A letter link came to hear
  // that letter: the tour waits, unmarked, for the next visit.
  if (opts.send && !document.querySelector("dialog[open]")) {
    const url = new URL(location.href);
    const asked = url.searchParams.has("tour");
    if (asked) {
      url.searchParams.delete("tour");
      history.replaceState(history.state, "", url);
    }
    if (asked || (!tourDone() && !opts.letterId)) tour();
  }

  return {
    state: (): StationState => state,
    unmount() {
      mounted = false;
      endTour();
      clearTimeout(dialTimer);
      clearInterval(nightTimer);
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(lampFrame);
      sounds.close();
      clearToast();
      flight?.remove();
      document.documentElement.removeAttribute("data-on-air");
      document.documentElement.removeAttribute("data-night");
      document.removeEventListener("click", onCardClick);
      document.removeEventListener("submit", onLangSubmit);
      abort.abort();
      player.stopBed();
      reactRoot.unmount();
    },
  };
}

/**
 * The home's send modal: the button (drawn by this script, in the send panel above the on-air list; without script the way to `/put` is the header's link) opens the `<dialog>`, whose frame loads `/put?embed=1`
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
    // Drawn as the modal goes, so it is seen on the face and not behind the backdrop.
    closing = setTimeout(() => {
      dialog.close();
      envelope(doc, "drawn");
    }, SENT_CLOSE_MS);
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
    askName: el.dataset.askName === "1",
    strings,
  });
}

if (typeof document !== "undefined") {
  boot();
  wireSendModal();
  wireShare();
}
