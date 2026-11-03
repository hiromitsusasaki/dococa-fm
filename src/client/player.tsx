/** @jsxImportSource hono/jsx/dom */
import { flushSync } from "hono/jsx/dom";
import { createRoot } from "hono/jsx/dom/client";
import type { ScriptLine, Segment } from "../worker/types";
import { createBed, playClip } from "./audio";
import { loadVoices, pickVoice, speak } from "./speech";

export type PlayerItem = { title: string; creator: string; imageUrl: string | null; outLinks: Record<string, string> };
/** The slice of an episode the page embeds: no listener id, no verification report. */
export type PlayerEpisode = { id: string; segments: Segment[]; items: Record<string, PlayerItem> };
export type PlayerOptions = {
  voiceURI: string;
  nextUrl: string;
  /** When set, dj and letter lines are mp3s from `${ttsUrl}?episode=&line=` instead of Web Speech. */
  ttsUrl: string | null;
  dial?: number;
  strings?: Record<string, string>;
  navigate?: (url: string) => void;
};

type Status = "idle" | "playing" | "paused" | "ended";
type State = {
  status: Status;
  seg: number;
  line: number;
  /** True while the last line is done and the next episode is still being made. */
  loading: boolean;
  message: string | null;
  replyOpen: boolean;
  sent: Record<string, true>;
};
type Next = { ok: true; id: string } | { ok: false; reason: "limit" | "failed" };
type LetterLine = Extract<ScriptLine, { type: "letter" }>;

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const isHttpUrl = (s: string | null): s is string => s !== null && /^https?:\/\//i.test(s);
const fmt = (tpl: string, params: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m);

export function mountPlayer(root: HTMLElement, episode: PlayerEpisode, opts: PlayerOptions) {
  const str = (key: string) => opts.strings?.[key] ?? key;
  const navigate = opts.navigate ?? ((url: string) => location.assign(url));
  const segments = episode.segments;
  const bed = createBed();
  const reactRoot = createRoot(root);

  let state: State = { status: "idle", seg: 0, line: 0, loading: false, message: null, replyOpen: false, sent: {} };
  let abort = new AbortController();
  let prefetch: Promise<Next> | null = null;
  let voices: SpeechSynthesisVoice[] | null = null;

  const lineOf = (seg: number, line: number): ScriptLine | undefined => segments[seg]?.lines[line];
  /** Index of a line across the whole episode, which is what the TTS endpoint takes. */
  const globalIndex = (seg: number, line: number) => segments.slice(0, seg).reduce((n, s) => n + s.lines.length, 0) + line;
  const itemOf = (seg: number): PlayerItem | undefined => {
    const id = segments[seg]?.itemId;
    return id === undefined ? undefined : episode.items[id];
  };

  function setState(patch: Partial<State>) {
    const segChanged = patch.seg !== undefined && patch.seg !== state.seg;
    state = { ...state, ...patch };
    flushSync(() => reactRoot.render(<Screen s={state} view={view} />));
    if (segChanged || patch.status !== undefined) syncMediaSession();
  }

  function syncMediaSession() {
    const ms = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!ms) return;
    const item = itemOf(state.seg);
    if (item && typeof MediaMetadata !== "undefined") {
      ms.metadata = new MediaMetadata({
        title: item.title,
        artist: item.creator,
        artwork: isHttpUrl(item.imageUrl) ? [{ src: item.imageUrl }] : [],
      });
    }
    ms.playbackState = state.status === "playing" ? "playing" : "paused";
  }

  function ensureNext(): Promise<Next> {
    prefetch ??= fetch(opts.nextUrl, { method: "POST" })
      .then(async (res): Promise<Next> => {
        if (res.status === 429) return { ok: false, reason: "limit" };
        const body = res.ok ? ((await res.json()) as { id?: unknown }) : null;
        return typeof body?.id === "string" && body.id !== "" ? { ok: true, id: body.id } : { ok: false, reason: "failed" };
      })
      .catch((): Next => ({ ok: false, reason: "failed" }));
    return prefetch;
  }

  async function playLine(line: ScriptLine, seg: number, index: number, signal: AbortSignal) {
    if (line.type === "preview") {
      bed.stop();
      await playClip(line.url, signal, line.seconds);
      return;
    }
    bed.start();
    if (opts.ttsUrl !== null) {
      await playClip(`${opts.ttsUrl}?episode=${encodeURIComponent(episode.id)}&line=${globalIndex(seg, index)}`, signal);
      return;
    }
    voices ??= await loadVoices();
    if (!signal.aborted) await speak(line.text, pickVoice(voices, opts.voiceURI), signal);
  }

  /** The last line is done: hand over to the next episode, which has been made in the background since the second-to-last segment. */
  async function finish(signal: AbortSignal) {
    bed.stop();
    setState({ loading: true });
    const next = await ensureNext();
    if (signal.aborted) return;
    if (next.ok) return navigate(`/episodes/${encodeURIComponent(next.id)}`);
    setState({ status: "ended", loading: false, message: str(next.reason === "limit" ? "player.limit" : "player.failed") });
  }

  async function run(fromSeg: number, fromLine: number, signal: AbortSignal) {
    for (let i = fromSeg; i < segments.length; i++) {
      if (i >= Math.max(0, segments.length - 2)) void ensureNext();
      const lines = segments[i]!.lines;
      for (let j = i === fromSeg ? fromLine : 0; j < lines.length; j++) {
        if (signal.aborted) return;
        if (i !== state.seg || j !== state.line) setState({ seg: i, line: j, replyOpen: false });
        await playLine(lines[j]!, i, j, signal);
      }
    }
    if (!signal.aborted) await finish(signal);
  }

  /** Cancels whatever is sounding and starts reading from (seg, line). Called from a tap, so audio may start. */
  function startAt(seg: number, line: number) {
    abort.abort();
    abort = new AbortController();
    setState({ status: "playing", seg, line, loading: false, message: null, replyOpen: false });
    void run(seg, line, abort.signal);
  }

  function pause() {
    if (state.status !== "playing") return;
    abort.abort();
    bed.stop();
    setState({ status: "paused" });
  }

  function play() {
    if (state.status === "playing") return;
    if (state.status === "paused") startAt(state.seg, state.line);
    else startAt(0, 0);
  }

  function next() {
    if (state.seg + 1 < segments.length) return startAt(state.seg + 1, 0);
    abort.abort();
    abort = new AbortController();
    setState({ status: "playing", message: null, replyOpen: false });
    void finish(abort.signal);
  }

  async function postLetter(fields: Record<string, string>, key: string) {
    try {
      const res = await fetch("/letters", { method: "POST", headers: FORM, body: new URLSearchParams(fields).toString(), redirect: "manual" });
      // A successful post answers with a redirect; 409 means this person already said 私も.
      const ok = res.ok || res.type === "opaqueredirect" || res.status === 409 || (res.status >= 300 && res.status < 400);
      if (ok) setState({ sent: { ...state.sent, [key]: true }, replyOpen: false, message: null });
      else setState({ message: str("player.sendFailed") });
    } catch {
      setState({ message: str("player.sendFailed") });
    }
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
    watashimo() {
      const l = currentLetter();
      const itemId = segments[state.seg]?.itemId;
      if (l && itemId) void postLetter({ kind: "watashimo", itemId, parentLetterId: l.letterId }, `w:${l.letterId}`);
    },
    reply(body) {
      const l = currentLetter();
      const itemId = segments[state.seg]?.itemId;
      if (l && itemId && body.trim() !== "") void postLetter({ kind: "reply", body, itemId, parentLetterId: l.letterId }, `r:${l.letterId}`);
    },
    saveDial(value) {
      void fetch("/settings/dial", { method: "POST", headers: FORM, body: new URLSearchParams({ dial: value }).toString() }).catch(() => {});
    },
    dial: opts.dial ?? 0.3,
    item: (seg) => itemOf(seg),
    itemId: (seg) => segments[seg]?.itemId,
    line: (seg, line) => lineOf(seg, line),
  };

  if (typeof navigator !== "undefined" && navigator.mediaSession) {
    navigator.mediaSession.setActionHandler("play", play);
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("nexttrack", next);
  }
  setState({});
  syncMediaSession();

  return {
    state: () => state,
    unmount() {
      abort.abort();
      bed.stop();
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
};

function whoOf(l: LetterLine, str: View["str"]): string {
  if (l.kind === "found") return l.sourceAuthor ?? "";
  const who = l.radioName ? fmt(str("letter.who"), { name: l.radioName }) : str("listener.anonymous");
  return l.place ? fmt(str("letter.whoPlace"), { who, place: l.place }) : who;
}

function Screen({ s, view }: { s: State; view: View }) {
  const { str } = view;
  const item = view.item(s.seg);
  const itemId = view.itemId(s.seg);
  const line = view.line(s.seg, s.line);
  const letter = line?.type === "letter" ? line : null;
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
        {s.loading && <p class="muted">{str("player.loading")}</p>}
        {line?.type === "dj" && <p class="player-dj">{line.text}</p>}
        {line?.type === "preview" && <p class="player-dj" aria-hidden="true">♪</p>}
        {letter && (
          <blockquote class="player-letter">
            <p>{letter.text}</p>
            <footer class="letter-who">{whoOf(letter, str)}</footer>
          </blockquote>
        )}
      </div>
      {s.message && <p class="player-message" role="alert">{s.message}</p>}
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
              <input type="text" name="body" maxlength={140} aria-label={str("player.reply")} />
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
        <span>{str("player.dial")}</span>
        <input type="range" min="0" max="1" step="0.1" value={String(view.dial)} ref={onReleased(view.saveDial)} />
      </label>
    </div>
  );
}

/** Hono maps onChange to the `input` event, which fires all through a drag; the dial is saved once, on release. */
const onReleased = (save: (value: string) => void) => (el: HTMLInputElement | null) => {
  if (el) el.onchange = () => save(el.value);
};

/** `out.*` labels are shipped by the server; a service without one is not linked. */
const outLabel = (str: View["str"], key: string): string | null => {
  const label = str(`out.${key}`);
  return label === `out.${key}` ? null : label;
};

function boot() {
  const el = document.getElementById("player");
  const json = document.getElementById("episode-json");
  if (!el || !json) return;
  const strings = JSON.parse(document.getElementById("player-i18n")?.textContent ?? "{}") as Record<string, string>;
  const dial = Number.parseFloat(el.dataset.dial ?? "");
  mountPlayer(el, JSON.parse(json.textContent ?? "") as PlayerEpisode, {
    voiceURI: el.dataset.voice ?? "",
    nextUrl: el.dataset.nextUrl ?? "",
    ttsUrl: el.dataset.ttsUrl ? el.dataset.ttsUrl : null,
    ...(Number.isFinite(dial) ? { dial } : {}),
    strings,
  });
}

if (typeof document !== "undefined") boot();
