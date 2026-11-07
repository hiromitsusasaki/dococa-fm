import { Hono } from "hono";
import { raw } from "hono/html";
import { EpisodeRow, LetterCard, senderLine, whoOf } from "../../views/components";
import type { Variables } from "../auth/session";
import { listArchive } from "../db/episodes";
import { getPublicLetterWithTitle, listRecentPublicLetters } from "../db/letters";
import { listRecentPublicRadios } from "../db/listeners";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { displayText } from "../letters/display";
import type { Item } from "../types";
import { canAskLetter } from "../program/select";
import { stationLabel } from "../program/station";
import { StationPage } from "./stations";

export const home = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Programmes the listener heard, newest first, on the home. */
const RECENT_EPISODES = 3;

/** Public radios whose letters arrived most recently, on the home. */
const PUBLIC_RADIOS = 5;

/** Runs right after the hero, before it paints: a browser that has switched the radio on before sees the short hero. */
/** A letter link's preview quotes the letter this far. */
const PREVIEW_CHARS = 80;

/** Four arcs over the radio in the key visual (both crops are the same 3:2 picture). */
const KV_WAVES = "M582 504A34 34 0 0 0 522 504M610 489A66 66 0 0 0 494 489M639 474A98 98 0 0 0 465 474M667 459A130 130 0 0 0 437 459";

const HERO_COMPACT = `try{if(localStorage.getItem("dfm.seen"))document.currentScript.previousElementSibling.classList.add("compact")}catch(e){}`;

home.get("/", async (c) => {
  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  // A letter's link (`/?letter=`): the radio waits for the switch and then starts from it, only when the letter would take
  // the first seat (someone else's public letter, readable for this listener, as the first `next` checks); otherwise the
  // home is the ordinary one. A public letter also gives the link its preview.
  const asked = c.req.query("letter") ?? "";
  const wanted = asked.length > 0 && asked.length <= 100 ? asked : undefined;
  const [recent, heard, shared, radios] = await Promise.all([
    listRecentPublicLetters(c.env.DB, 6),
    listArchive(c.env.DB, listener.id, RECENT_EPISODES),
    wanted ? getPublicLetterWithTitle(c.env.DB, wanted) : null,
    listRecentPublicRadios(c.env.DB, PUBLIC_RADIOS),
  ]);
  const letter = shared && wanted && (await canAskLetter(c.env.DB, listener, shared.letter)) ? wanted : undefined;
  const og = shared && wanted
    ? { title: shared.title, description: Array.from(displayText(shared.letter, lang).main).slice(0, PREVIEW_CHARS).join(""), url: `${c.env.PUBLIC_ORIGIN}/?letter=${encodeURIComponent(wanted)}` }
    : undefined;
  const hero = (
    <section class="hero">
      <div class="copy">
        <h1 class="wordmark">{t("app.name")}</h1>
        <p class="tagline">{t("app.tagline")}</p>
      </div>
      <div class="kv">
        <picture>
          <source media="(max-width: 760px)" srcset="/kv-mobile.jpg" />
          <img src="/kv.jpg" alt={t("home.kvAlt")} width="1280" height="853" loading="eager" fetchpriority="high" />
        </picture>
        {/* The radio's waves, drawn over the picture's own: they sway while the radio is on (html[data-on-air]). */}
        <svg class="kv-waves" viewBox="0 0 1280 853" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <path d={KV_WAVES} />
        </svg>
      </div>
    </section>
  );
  const heroBoot = <script>{raw(HERO_COMPACT)}</script>;
  return c.html(
    <StationPage stationKey="mine" title={t("app.name")} label={stationLabel({ kind: "mine" }, "", lang)} lang={lang} listener={listener} path={letter ? `/?letter=${encodeURIComponent(letter)}` : "/"} voice={listener.voice} dial={listener.dial} grow={false} hideName top={<>{hero}{heroBoot}</>} send letter={letter} og={og}>
      <section class="home">
        {/* The station script opens this over the page, so the radio keeps playing; the frame loads on the first open. */}
        <dialog class="send-modal" aria-label={t("put.title")}>
          <form method="dialog" class="send-modal-bar">
            <button type="submit" class="quiet">{t("home.close")}</button>
          </form>
          <iframe data-src="/put?embed=1" title={t("put.title")}></iframe>
        </dialog>
        <p class="muted">
          {t("home.explain")}
          {lang === "en" && " "}
          <a href="/start">{t("home.explainStart")}</a>
        </p>
        {heard.length > 0 && (
          <section class="panel recent-episodes">
            <h2>{t("episode.archive")}</h2>
            <ul class="up-next">
              {heard.map((e) => (
                <EpisodeRow id={e.id} kind={e.kind as Item["kind"] | null} title={e.title} creator={e.creator} imageUrl={e.imageUrl} sender={e.sender ? senderLine(e.sender, lang) : null} lang={lang} />
              ))}
            </ul>
            <a href="/episodes">{t("home.seeAll")}</a>
          </section>
        )}
        {radios.length > 0 && (
          <section class="public-radios">
            <h2>{t("home.publicRadios")}</h2>
            <ul class="public-radio-list">
              {radios.map((r) => (
                <li>
                  <a href={`/stations/s:${r.slug}`}>{whoOf(r, lang)}</a>
                </li>
              ))}
            </ul>
          </section>
        )}
        {recent.length > 0 && (
          <section>
            <h2>{t("home.recent")}</h2>
            <ul class="letter-cards">
              {recent.map((l) => (
                <li>
                  <LetterCard letter={l} item={l.item} lang={lang} viewerId={listener.id} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </section>
    </StationPage>,
  );
});
