/** @jsxImportSource hono/jsx/dom */
import { LetterQuote } from "./letter-quote";
import { isHttpUrl, type LetterLine, outLabel, type PlayerItem, type PlayerOriginals } from "./playback";
import { xIntentUrl } from "../views/share";
import { onReleased } from "./reactions";
import { canShare } from "./share";

/**
 * `sender` is the first reader's name line; absent for a work nobody has written about. `letterId` is only on the row now on air, for the
 * reactions on the now-playing card; `shareable` is false for a reply or 私も (an echo of the listener's own letter), which has no page to share
 * and nothing to answer (the card shows no reactions),
 * and `shareText` is the short text a share goes out with;
 * `reading` too: how far down the segment's lines the voice is (0 at the first line, 1 at the last), drawn as a thin line that moves down the row.
 */
export type UpNextRow = { key: string; now: boolean; kind: string | null; title: string; creator: string; sender?: string; letterId?: string; imageUrl?: string | null; reading?: number; shareable?: boolean; shareText?: string };

export type StationScreenProps = {
  str: (key: string) => string;
  power: "off" | "tuning" | "on" | "limit" | "failed";
  /** Between episodes: the last line is done and the next episode is still being made. */
  loading: boolean;
  /** `limit`, `failed` or `empty`, shown as the matching message. */
  reason: string | null;
  /** The message key of the last reaction that did not go out, or null. */
  sendFailed: string | null;
  volume: number;
  dial: number | null;
  /** The dial works yet; before, it is drawn locked (no needle, a lock, the line saying three letters wake it) and does not turn. */
  dialReady: boolean;
  /** It woke on this visit: it lights and its needle sweeps in once. */
  woke: boolean;
  /** A letter link is waiting for the switch: it says it plays from that letter. */
  primed: boolean;
  /** The home: the right column opens with the send panel, whose button opens the send modal. */
  send: boolean;
  item: PlayerItem | undefined;
  itemId: string | undefined;
  letter: LetterLine | null;
  original: PlayerOriginals[string] | undefined;
  djText: string | null;
  upNext: UpNextRow[];
  /** The listener has no radio name yet: the 一言 form offers to add one (and a place, from the page's `#place-fields`). */
  askName: boolean;
  sent: Record<string, true>;
  on: {
    power: () => void;
    volume: (value: number) => void;
    dial: (value: string) => void;
    /** The dial moved one detent (during the drag, before `dial`). */
    tick: () => void;
    watashimo: (letterId: string) => void;
    /** `profile`: the radio name and place typed in the form's optional line, only those filled in. */
    reply: (body: string, letterId: string, profile?: Record<string, string>) => Promise<boolean> | void;
    /** Opens the home's tour again (the face's quiet 「使い方」). */
    tour: () => void;
  };
};

const REASON_KEY: Record<string, string> = { limit: "station.limit", failed: "station.failed", empty: "station.empty" };

export function StationScreen(p: StationScreenProps) {
  const { str } = p;
  const lit = p.power === "on" || p.power === "tuning";
  const status = p.reason ? str(REASON_KEY[p.reason] ?? "station.failed") : p.power === "tuning" ? str("station.searching") : p.loading ? str("station.tuning") : p.sendFailed ? str(p.sendFailed) : "";
  const links = Object.entries(p.item?.outLinks ?? {}).flatMap(([key, href]) => {
    const label = outLabel(str, key);
    return label && isHttpUrl(href) ? [{ label, href }] : [];
  });
  const onAir = p.upNext.find((r) => r.now && r.letterId);
  const meta = p.item ? [p.item.kind ? kindLabel(str, p.item.kind) : null, p.item.year ? String(p.item.year) : null].filter((x): x is string => x !== null) : [];
  return (
    <div class="station">
      <section class="panel radio">
        <div class="face">
          <span class="brand">DOCOCA FM</span>
          {p.send && (
            <button type="button" class="quiet tour-again" onClick={p.on.tour}>
              {str("station.tour")}
            </button>
          )}
          {p.power === "on" && <span class="live">{str("station.onAir")}</span>}
          {p.power === "tuning" && <span class="tuning" aria-hidden="true">{str("station.tuning")}</span>}
        </div>
        <div class={`scale${lit ? " lit" : ""}${p.power === "on" ? " sweep" : ""}`} style={{ "--needle": needle(p.dialReady ? p.dial : null) }} aria-hidden="true"></div>
        <div class="controls">
          <div class="control">
            <button type="button" class="switch" data-action="power" aria-pressed={String(lit)} aria-label={str("station.onOff")} onClick={p.on.power}></button>
            <span id="station-switch-label" class="control-label">
              {str(lit ? "station.off" : p.primed ? "station.playFromLetter" : "station.on")}
            </span>
          </div>
          <label class="knob knob-volume">
            <span class="dial-row">
              <span class="dial-end">{str("station.volumeLow")}</span>
              <span class="knob-body" style={{ "--angle": angle(p.volume) }}>
                <i></i>
                <input type="range" min="0" max="100" step="1" data-action="volume" aria-label={str("station.volume")} value={String(Math.round(p.volume * 100))} onInput={(e: Event) => p.on.volume(Number((e.currentTarget as HTMLInputElement).value) / 100)} />
              </span>
              <span class="dial-end">{str("station.volumeHigh")}</span>
            </span>
            <span class="control-label">{str("station.volume")}</span>
          </label>
          {p.dial !== null && (
            <label class={`knob knob-dial ${p.dialReady ? (p.woke ? "ready woke" : "ready") : "locked"}`} title={p.dialReady ? str("station.dialHelp") : undefined}>
              <span class="dial-row">
                <span class="dial-end">{str("station.dialNear")}</span>
                <span class="knob-body" style={{ "--angle": angle(p.dial) }}>
                  <i></i>
                  <b class="knob-lock" aria-hidden="true"></b>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    data-action="dial"
                    aria-label={str("station.dial")}
                    value={String(p.dial)}
                    disabled={!p.dialReady}
                    aria-describedby={p.dialReady ? undefined : "dial-locked"}
                    ref={onReleased(p.on.dial)}
                    onInput={(e: Event) => {
                      const input = e.currentTarget as HTMLInputElement;
                      input.parentElement?.style.setProperty("--angle", angle(Number(input.value)));
                      // The needle hops with each detent; the radio keeps the value once the dial is let go.
                      input.closest(".radio")?.querySelector<HTMLElement>(".scale")?.style.setProperty("--needle", needle(Number(input.value)));
                      p.on.tick();
                    }}
                  />
                </span>
                <span class="dial-end">{str("station.dialFar")}</span>
              </span>
              <span class="control-label" id={p.dialReady ? undefined : "dial-locked"}>
                {str(p.dialReady ? "station.dial" : "station.dialLocked")}
              </span>
            </label>
          )}
        </div>
        <p class="station-status" role="status">
          {status}
        </p>
      </section>

      {p.item && (
        <section class="now panel">
          <p class="eyebrow">{str("station.nowPlaying")}</p>
          <div class="now-item">
            {isHttpUrl(p.item.imageUrl) && <img class="art" src={p.item.imageUrl} alt="" width="120" height="120" />}
            <div>
              <h2>{p.item.title}</h2>
              <p class="item-creator">{p.item.creator}</p>
              {meta.length > 0 && <p class="muted">{meta.join(" · ")}</p>}
            </div>
          </div>
          <div class="now-line" aria-live="polite">
            {p.djText !== null && <p class="player-dj">{p.djText}</p>}
            {p.letter && <LetterQuote letter={p.letter} original={p.original} str={str} toggleKey="letter.showOriginal" />}
          </div>
          {/* Letters and found voices are read verbatim, or in a translation when the card shows one (the original behind its toggle);
              the DJ's own words get no note. */}
          {p.letter && <p class="muted verbatim">{str(p.original?.original != null && p.original.original !== p.original.main ? "station.verbatimTranslated" : "station.verbatim")}</p>}
          {links.length > 0 && (
            <div class="again" data-action="again">
              <p class="muted">{str("player.again")}</p>
              <ul class="out-links">
                {links.map((l) => (
                  <li>
                    <a class="pill" href={l.href} target="_blank" rel="noopener noreferrer">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* An echo has no letter to answer: its 私も and 一言 would go to a reaction, which the server refuses. */}
          {onAir && onAir.shareable !== false && <NowReact id={onAir.letterId!} askName={p.askName} share={onAir.shareText ?? ""} sent={p.sent} str={str} on={p.on} />}
        </section>
      )}

      <aside class="side">
        {p.send && (
          <section class="panel send-panel">
            <h2>{str("home.put")}</h2>
            <p class="muted">{str("home.sendLead")}</p>
            <a class="button" href="/put" data-open-send>
              {str("home.put")}
            </a>
          </section>
        )}
        <section class="panel on-air">
          <h2>{str("station.panel")}</h2>
          {p.upNext.length === 0 && p.power === "off" && <p class="muted">{str("station.offHint")}</p>}
          <ul class="up-next">
            {p.upNext.map((r) => (
              <li key={r.key} class={r.now ? "now" : ""}>
                {/* The on-air row's text is one box, so the reading line moves over the text only. */}
                <span class="row-text">
                  <span class="tag">{str(r.now ? "station.now" : "station.next")}</span>
                  {r.now && isHttpUrl(r.imageUrl) && <img class="thumb" src={r.imageUrl} alt="" width="40" height="40" />}
                  {r.kind && <span class="kind">{kindLabel(str, r.kind)}</span>}
                  <span class="title">{r.title}</span>
                  <span class="creator">{r.creator}</span>
                  {r.sender && <span class="sender">{r.sender}</span>}
                  {r.reading !== undefined && <i class="reading" style={{ "--at": String(r.reading) }} aria-hidden="true"></i>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}

/**
 * 私も, 一言 and the ways to share for the segment's letter, on the now-playing card, through the whole segment. `share` is the short
 * text. The share sheet's button shows where the browser has one; `wireShare` handles its click and the copy.
 */
function NowReact({ id, askName, share, sent, str, on }: { id: string; askName: boolean; share: string; sent: Record<string, true>; str: (key: string) => string; on: StationScreenProps["on"] }) {
  const said = sent[`w:${id}`] === true;
  const url = `${location.origin}/letters/${encodeURIComponent(id)}`;
  return (
    <div class="react">
      <button type="button" class={said ? "pill hot said" : "pill hot"} data-action="watashimo" disabled={said} onClick={() => on.watashimo(id)}>
        {str(said ? "player.sent" : "player.watashimo")}
      </button>
      <form
        class="reply"
        onSubmit={(e: Event) => {
          e.preventDefault();
          const form = e.currentTarget as HTMLFormElement;
          const ta = form.querySelector("textarea")!;
          const body = ta.value;
          const profile: Record<string, string> = {};
          for (const name of PROFILE) {
            const v = (form.elements.namedItem(name) as HTMLInputElement | null)?.value.trim();
            if (v) profile[name] = v;
          }
          // Words typed while the post was on its way are a new draft: keep them.
          void Promise.resolve(on.reply(body, id, profile)).then((taken) => {
            if (taken && ta.value === body) ta.value = "";
          });
        }}
      >
        <textarea name="body" maxlength={200} rows={2} aria-label={str("player.replyLabel")}></textarea>
        {askName && (
          // The place lists are cloned into the slot when the line opens (the page's script); the radio leaves the slot's children alone.
          <details class="reply-name">
            <summary>{str("reply.addName")}</summary>
            <label>
              <span>{str("settings.radioName")}</span>
              <input type="text" name="radioName" maxlength={20} />
            </label>
            <div class="place-slot"></div>
          </details>
        )}
        <button type="submit" class="pill">
          {str(sent[`r:${id}`] ? "player.sent" : "player.reply")}
        </button>
      </form>
      <div class="share">
        <a class="pill" href={xIntentUrl(share, url)} target="_blank" rel="noopener">
          {str("share.x")}
        </a>
        <button type="button" class="pill" data-share={url} data-text={share} hidden={!canShare()}>
          {str("share.native")}
        </button>
        <button type="button" class="pill" data-copy={url} data-copied={str("station.shared")}>
          {str("station.share")}
        </button>
      </div>
    </div>
  );
}

const PROFILE = ["radioName", "placeCountry", "placeRegion"] as const;

/** The needle sweeps from -135deg (0) to +135deg (1). */
function angle(fraction: number): string {
  return `${Math.round(-135 + 270 * Math.min(1, Math.max(0, fraction)))}deg`;
}

/** Where the scale's needle rests: the dial's place along it, or the middle on a radio without a dial. */
function needle(dial: number | null): string {
  return `${dial === null ? 50 : Math.round(10 + 80 * Math.min(1, Math.max(0, dial)))}%`;
}

/** `kind.*` is shipped for the labels; an unknown kind shows nothing rather than its key. */
function kindLabel(str: (key: string) => string, kind: string): string {
  const label = str(`kind.${kind}`);
  return label === `kind.${kind}` ? "" : label;
}
