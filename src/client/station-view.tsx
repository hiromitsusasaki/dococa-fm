/** @jsxImportSource hono/jsx/dom */
import { LetterQuote } from "./letter-quote";
import { isHttpUrl, type LetterLine, outLabel, type PlayerItem, type PlayerOriginals } from "./playback";
import { onReleased } from "./reactions";

/** `sender` is the first reader's name line; absent for a work nobody has written about. `letterId` is only on the row now on air, for the reactions. */
export type UpNextRow = { key: string; now: boolean; kind: string | null; title: string; creator: string; sender?: string; letterId?: string };

export type StationScreenProps = {
  str: (key: string) => string;
  power: "off" | "tuning" | "on" | "limit" | "failed";
  /** Between episodes: the last line is done and the next episode is still being made. */
  loading: boolean;
  /** `limit`, `failed` or `empty`, shown as the matching message. */
  reason: string | null;
  sendFailed: boolean;
  volume: number;
  dial: number | null;
  grow: boolean;
  item: PlayerItem | undefined;
  itemId: string | undefined;
  letter: LetterLine | null;
  original: PlayerOriginals[string] | undefined;
  djText: string | null;
  upNext: UpNextRow[];
  replyOpen: boolean;
  sent: Record<string, true>;
  on: {
    power: () => void;
    volume: (value: number) => void;
    dial: (value: string) => void;
    toggleReply: () => void;
    watashimo: (letterId?: string) => void;
    reply: (body: string, letterId?: string) => Promise<boolean> | void;
  };
};

const REASON_KEY: Record<string, string> = { limit: "station.limit", failed: "station.failed", empty: "station.empty" };

export function StationScreen(p: StationScreenProps) {
  const { str } = p;
  const lit = p.power === "on" || p.power === "tuning";
  const status = p.reason ? str(REASON_KEY[p.reason] ?? "station.failed") : p.power === "tuning" || p.loading ? str("station.tuning") : p.sendFailed ? str("player.sendFailed") : "";
  const links = Object.entries(p.item?.outLinks ?? {}).flatMap(([key, href]) => {
    const label = outLabel(str, key);
    return label && isHttpUrl(href) ? [{ label, href }] : [];
  });
  const meta = p.item ? [p.item.kind ? kindLabel(str, p.item.kind) : null, p.item.year ? String(p.item.year) : null].filter((x): x is string => x !== null) : [];
  return (
    <div class="station">
      <section class="panel radio">
        <div class="face">
          <span class="brand">DOCOCA FM</span>
          {p.power === "on" && <span class="live">{str("station.onAir")}</span>}
          {p.power === "tuning" && <span class="tuning" aria-hidden="true">{str("station.tuning")}</span>}
        </div>
        <div class={p.power === "on" ? "scale sweep" : "scale"} aria-hidden="true"></div>
        <div class="controls">
          <div class="control">
            <button type="button" class="switch" data-action="power" aria-pressed={String(lit)} aria-label={str("station.onOff")} disabled={p.grow} onClick={p.on.power}></button>
            <span id="station-switch-label" class="control-label">
              {str(lit ? "station.off" : "station.on")}
            </span>
          </div>
          <label class="knob knob-volume">
            <span class="knob-body" style={{ "--angle": angle(p.volume) }}>
              <i></i>
              <input type="range" min="0" max="100" step="1" data-action="volume" aria-label={str("station.volume")} value={String(Math.round(p.volume * 100))} onInput={(e: Event) => p.on.volume(Number((e.currentTarget as HTMLInputElement).value) / 100)} />
            </span>
            <span class="control-label">{str("station.volume")}</span>
          </label>
          {p.dial !== null && (
            <label class="knob knob-dial" title={str("station.dialHelp")}>
              <span class="knob-body" style={{ "--angle": angle(p.dial) }}>
                <i></i>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  data-action="dial"
                  aria-label={str("station.dial")}
                  value={String(p.dial)}
                  ref={onReleased(p.on.dial)}
                  onInput={(e: Event) => {
                    const input = e.currentTarget as HTMLInputElement;
                    input.parentElement?.style.setProperty("--angle", angle(Number(input.value)));
                  }}
                />
              </span>
              <span class="control-label">{str("station.dial")}</span>
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
          {p.letter && (
            <div class="react">
              <button type="button" class="pill hot" data-action="watashimo" disabled={p.sent[`w:${p.letter.letterId}`] === true} onClick={() => p.on.watashimo()}>
                {str(p.sent[`w:${p.letter.letterId}`] ? "player.sent" : "player.watashimo")}
              </button>
              <button type="button" class="pill" data-action="reply" aria-expanded={String(p.replyOpen)} onClick={p.on.toggleReply}>
                {str(p.sent[`r:${p.letter.letterId}`] ? "player.sent" : "player.reply")}
              </button>
              {p.replyOpen && (
                <form
                  class="reply"
                  onSubmit={(e: Event) => {
                    e.preventDefault();
                    p.on.reply((e.currentTarget as HTMLFormElement).querySelector("input")!.value);
                  }}
                >
                  <input type="text" name="body" maxlength={200} aria-label={str("player.reply")} />
                  <button type="submit" class="pill">
                    {str("player.send")}
                  </button>
                </form>
              )}
            </div>
          )}
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
        </section>
      )}

      <aside class="side panel">
        <h2>{str("station.panel")}</h2>
        {p.upNext.length === 0 && p.power === "off" && !p.grow && <p class="muted">{str("station.offHint")}</p>}
        <ul class="up-next">
          {p.upNext.map((r) => (
            <li key={r.key} class={r.now ? "now" : ""}>
              <span class="tag">{str(r.now ? "station.now" : "station.next")}</span>
              {r.kind && <span class="kind">{kindLabel(str, r.kind)}</span>}
              <span class="title">{r.title}</span>
              <span class="creator">{r.creator}</span>
              {r.sender && <span class="sender">{r.sender}</span>}
              {r.letterId && <PanelReact id={r.letterId} sent={p.sent} str={str} on={p.on} />}
            </li>
          ))}
        </ul>
        {p.grow && (
          <div class="grow">
            <h2>{str("station.grow")}</h2>
            <p>{str("station.growHelp")}</p>
            <a class="pill hot" href="/start">
              {str("station.growStart")}
            </a>
          </div>
        )}
      </aside>
    </div>
  );
}

/** 私も and 一言 for the letter on air, in the panel; they share `sent` with the player card. */
function PanelReact({ id, sent, str, on }: { id: string; sent: Record<string, true>; str: (key: string) => string; on: StationScreenProps["on"] }) {
  const said = sent[`w:${id}`] === true;
  return (
    <div class="panel-react">
      <button type="button" class="pill hot" data-action="panel-watashimo" disabled={said} onClick={() => on.watashimo(id)}>
        {str(said ? "player.sent" : "player.watashimo")}
      </button>
      <form
        class="panel-reply"
        onSubmit={(e: Event) => {
          e.preventDefault();
          const ta = (e.currentTarget as HTMLFormElement).querySelector("textarea")!;
          void Promise.resolve(on.reply(ta.value, id)).then((taken) => {
            if (taken) ta.value = "";
          });
        }}
      >
        <textarea name="body" maxlength={200} rows={2} aria-label={str("player.replyLabel")}></textarea>
        <button type="submit" class="pill">
          {str(sent[`r:${id}`] ? "player.sent" : "player.reply")}
        </button>
      </form>
    </div>
  );
}

/** The needle sweeps from -135deg (0) to +135deg (1). */
function angle(fraction: number): string {
  return `${Math.round(-135 + 270 * Math.min(1, Math.max(0, fraction)))}deg`;
}

/** `kind.*` is shipped for the labels; an unknown kind shows nothing rather than its key. */
function kindLabel(str: (key: string) => string, kind: string): string {
  const label = str(`kind.${kind}`);
  return label === `kind.${kind}` ? "" : label;
}
