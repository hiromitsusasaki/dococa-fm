/** @jsxImportSource hono/jsx/dom */
import { flushSync } from "hono/jsx/dom";
import { createRoot } from "hono/jsx/dom/client";
import type { ScriptLine } from "../worker/types";
import { LetterQuote } from "./letter-quote";
import {
  bindMediaSession,
  createLinePlayer,
  isHttpUrl,
  type LetterLine,
  outLabel,
  type PlayerEpisode,
  type PlayerItem,
  type PlayerOriginals,
  reportListen,
  syncMediaSession,
} from "./playback";
import { loadDial, onReleased, postLetter, reactionOf, storeDial } from "./reactions";

export type { PlayerEpisode, PlayerItem, PlayerOriginals };
/**
 * The episode page: plays one stored episode again (a link from my page or the archive). It makes no new episode, so
 * replaying spends none of the day's 枠; at the end it links to the listener's own radio to go on.
 */
export type PlayerOptions = {
  voiceURI: string;
  /** When set, dj and letter lines are mp3s from `${ttsUrl}?episode=&line=` instead of Web Speech. */
  ttsUrl: string | null;
  /** Where a letter that starts playing is reported (`POST`, JSON); absent means nothing is recorded. */
  listensUrl?: string;
  /** The dial shown; a turn is kept in this browser for the station page. */
  dial?: number;
  /** Segment to start from (line 0), for "listen again" links; out of range means 0. */
  startSeg?: number;
  strings?: Record<string, string>;
};

type Status = "idle" | "playing" | "paused" | "ended";
type State = {
  status: Status;
  seg: number;
  line: number;
  message: string | null;
  replyOpen: boolean;
  sent: Record<string, true>;
};
export function mountPlayer(root: HTMLElement, episode: PlayerEpisode, opts: PlayerOptions) {
  const str = (key: string) => opts.strings?.[key] ?? key;
  const segments = episode.segments;
  const player = createLinePlayer({ voiceURI: opts.voiceURI, ttsUrl: opts.ttsUrl, lang: str("lang.code") === "en" ? "en" : "ja" });
  const reactRoot = createRoot(root);

  const startSeg = Number.isInteger(opts.startSeg) && opts.startSeg! >= 0 && opts.startSeg! < segments.length ? opts.startSeg! : 0;
  let state: State = { status: "idle", seg: startSeg, line: 0, message: null, replyOpen: false, sent: {} };
  let abort = new AbortController();
  const lineOf = (seg: number, line: number): ScriptLine | undefined => segments[seg]?.lines[line];
  const itemOf = (seg: number): PlayerItem | undefined => {
    const id = segments[seg]?.itemId;
    return id === undefined ? undefined : episode.items[id];
  };

  function setState(patch: Partial<State>) {
    const segChanged = patch.seg !== undefined && patch.seg !== state.seg;
    state = { ...state, ...patch };
    flushSync(() => reactRoot.render(<Screen s={state} view={view} />));
    if (segChanged || patch.status !== undefined) sync();
  }

  const sync = () => syncMediaSession(itemOf(state.seg), state.status === "playing");

  /** The last line is done (or skipped): stop here and offer the listener's own radio. */
  function finish() {
    player.stopBed();
    setState({ status: "ended", message: null });
  }

  async function run(fromSeg: number, fromLine: number, signal: AbortSignal) {
    for (let i = fromSeg; i < segments.length; i++) {
      const lines = segments[i]!.lines;
      for (let j = i === fromSeg ? fromLine : 0; j < lines.length; j++) {
        if (signal.aborted) return;
        if (i !== state.seg || j !== state.line) setState({ seg: i, line: j, replyOpen: false });
        const line = lines[j]!;
        if (opts.listensUrl && line.type === "letter" && line.kind !== "reply") reportListen(opts.listensUrl, { episodeId: episode.id, letterId: line.letterId, segmentIndex: i });
        await player.play(episode, i, j, signal);
      }
    }
    if (!signal.aborted) finish();
  }

  /** Cancels whatever is sounding and starts reading from (seg, line). Called from a tap, so audio may start. */
  function startAt(seg: number, line: number) {
    player.unlock();
    abort.abort();
    abort = new AbortController();
    setState({ status: "playing", seg, line, message: null, replyOpen: false });
    void run(seg, line, abort.signal);
  }

  function pause() {
    if (state.status !== "playing") return;
    abort.abort();
    player.stopBed();
    setState({ status: "paused" });
  }

  function play() {
    if (state.status === "playing") return;
    if (state.status === "paused") startAt(state.seg, state.line);
    else startAt(state.status === "idle" ? startSeg : 0, 0);
  }

  function next() {
    if (state.seg + 1 < segments.length) return startAt(state.seg + 1, 0);
    abort.abort();
    abort = new AbortController();
    setState({ replyOpen: false });
    finish();
  }

  async function send(fields: Record<string, string>, key: string) {
    if (await postLetter(fields)) setState({ sent: { ...state.sent, [key]: true }, replyOpen: false, message: null });
    else setState({ message: str("player.sendFailed") });
  }

  function react(kind: "watashimo" | "reply", body?: string) {
    const r = reactionOf(kind, segments[state.seg]?.itemId, currentLetter()?.letterId, body);
    if (r) void send(r.fields, r.key);
  }

  const currentLetter = (): LetterLine | null => {
    const l = lineOf(state.seg, state.line);
    return l?.type === "letter" ? l : null;
  };

  const view: View = {
    str,
    toggle: () => (state.status === "playing" ? pause() : play()),
    next,
    toggleReply: () => setState({ replyOpen: !state.replyOpen }),
    watashimo: () => react("watashimo"),
    reply: (body) => react("reply", body),
    saveDial: (value: string) => void storeDial(value),
    dial: loadDial(opts.dial),
    item: (seg) => itemOf(seg),
    itemId: (seg) => segments[seg]?.itemId,
    line: (seg, line) => lineOf(seg, line),
    original: (letterId) => episode.originals?.[letterId],
  };

  bindMediaSession({ play, pause, next });
  setState({});
  sync();

  return {
    state: () => state,
    unmount() {
      abort.abort();
      player.stopBed();
      reactRoot.unmount();
    },
  };
}

type View = {
  str: (key: string) => string;
  toggle: () => void;
  next: () => void;
  toggleReply: () => void;
  watashimo: () => void;
  reply: (body: string) => void;
  saveDial: (value: string) => void;
  dial: number;
  item: (seg: number) => PlayerItem | undefined;
  itemId: (seg: number) => string | undefined;
  line: (seg: number, line: number) => ScriptLine | undefined;
  original: (letterId: string) => PlayerOriginals[string] | undefined;
};

function Screen({ s, view }: { s: State; view: View }) {
  const { str } = view;
  const item = view.item(s.seg);
  const itemId = view.itemId(s.seg);
  const line = view.line(s.seg, s.line);
  const letter = line?.type === "letter" ? line : null;
  const original = letter ? view.original(letter.letterId) : undefined;
  const links = Object.entries(item?.outLinks ?? {}).flatMap(([key, href]) => {
    const label = outLabel(str, key);
    return label && isHttpUrl(href) ? [{ label, href }] : [];
  });
  return (
    <div class="player">
      {item && (
        <section class="item-card player-card">
          {isHttpUrl(item.imageUrl) && <img src={item.imageUrl} alt="" width="120" height="120" />}
          <div>
            <h2>{item.title}</h2>
            <p class="item-creator">{item.creator}</p>
          </div>
        </section>
      )}
      <div class="player-line" aria-live="polite">
        {line?.type === "dj" && <p class="player-dj">{line.text}</p>}
        {letter && (
          <LetterQuote letter={letter} original={original} str={str} toggleKey="letter.showOriginal" />
        )}
      </div>
      {s.message && <p class="player-message" role="alert">{s.message}</p>}
      {s.status === "ended" && (
        <a class="button" data-action="continue" href="/stations/mine">
          {str("episode.continueOnStation")}
        </a>
      )}
      <div class="player-controls">
        <button type="button" class="primary" data-action="toggle" onClick={view.toggle}>
          {str(s.status === "playing" ? "player.pause" : "player.play")}
        </button>
        <button type="button" data-action="next" onClick={view.next}>
          {str("player.next")}
        </button>
      </div>
      {letter && (
        <div class="player-react">
          <button type="button" data-action="watashimo" disabled={s.sent[`w:${letter.letterId}`] === true} onClick={view.watashimo}>
            {str(s.sent[`w:${letter.letterId}`] ? "player.sent" : "player.watashimo")}
          </button>
          <button type="button" data-action="reply" aria-expanded={s.replyOpen} onClick={view.toggleReply}>
            {str(s.sent[`r:${letter.letterId}`] ? "player.sent" : "player.reply")}
          </button>
          {s.replyOpen && (
            <form
              class="reply"
              onSubmit={(e: Event) => {
                e.preventDefault();
                view.reply((e.currentTarget as HTMLFormElement).querySelector("input")!.value);
              }}
            >
              <input type="text" name="body" maxlength={200} aria-label={str("player.reply")} />
              <button type="submit">{str("player.send")}</button>
            </form>
          )}
        </div>
      )}
      <div class="player-again" data-action="again">
        <p class="muted">{str("player.again")}</p>
        <ul class="out-links">
          {links.map((l) => (
            <li>
              <a href={l.href} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
      {itemId && (
        <a class="button" data-action="put" href={`/put?itemId=${encodeURIComponent(itemId)}`} target="_blank" rel="noopener">
          {str("player.put")}
        </a>
      )}
      <label class="player-dial">
        <span>{str("station.dial")}</span>
        <input type="range" min="0" max="1" step="0.1" value={String(view.dial)} ref={onReleased(view.saveDial)} />
      </label>
    </div>
  );
}

function boot() {
  const el = document.getElementById("player");
  const json = document.getElementById("episode-json");
  if (!el || !json) return;
  const strings = JSON.parse(document.getElementById("player-i18n")?.textContent ?? "{}") as Record<string, string>;
  const dial = Number.parseFloat(el.dataset.dial ?? "");
  const startSeg = Number.parseInt(el.dataset.startSeg ?? "", 10);
  mountPlayer(el, JSON.parse(json.textContent ?? "") as PlayerEpisode, {
    voiceURI: el.dataset.voice ?? "",
    ttsUrl: el.dataset.ttsUrl ? el.dataset.ttsUrl : null,
    ...(el.dataset.listensUrl ? { listensUrl: el.dataset.listensUrl } : {}),
    ...(Number.isFinite(dial) ? { dial } : {}),
    ...(Number.isFinite(startSeg) ? { startSeg } : {}),
    strings,
  });
}

if (typeof document !== "undefined") boot();
