import { Hono } from "hono";
import { raw } from "hono/html";
import { EpisodeRow, LetterCard, senderLine } from "../../views/components";
import type { Variables } from "../auth/session";
import { listArchive } from "../db/episodes";
import { getPublicLetterWithTitle, listRecentPublicLetters } from "../db/letters";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { displayText } from "../letters/display";
import type { Item } from "../types";
import { stationLabel } from "../program/station";
import { StationPage } from "./stations";

export const home = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Programmes the listener heard, newest first, on the home. */
const RECENT_EPISODES = 3;

/** Runs right after the hero, before it paints: a browser that has switched the radio on before sees the short hero. */
/** A letter link's preview quotes the letter this far. */
const PREVIEW_CHARS = 80;

const HERO_COMPACT = `try{if(localStorage.getItem("dfm.seen"))document.currentScript.previousElementSibling.classList.add("compact")}catch(e){}`;

home.get("/", async (c) => {
  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  // A letter's link (`/?letter=`): the radio waits for the switch and then starts from it. Only its shape is checked here, as on
  // `/stations/mine?letter=`; the first `next` checks the rest. A public letter also gives the link its preview.
  const asked = c.req.query("letter") ?? "";
  const letter = asked.length > 0 && asked.length <= 100 ? asked : undefined;
  const [recent, heard, shared] = await Promise.all([
    listRecentPublicLetters(c.env.DB, 6),
    listArchive(c.env.DB, listener.id, RECENT_EPISODES),
    letter ? getPublicLetterWithTitle(c.env.DB, letter) : null,
  ]);
  const og = shared && letter
    ? { title: shared.title, description: Array.from(displayText(shared.letter, lang).main).slice(0, PREVIEW_CHARS).join(""), url: `${c.env.PUBLIC_ORIGIN}/?letter=${encodeURIComponent(letter)}` }
    : undefined;
  const hero = (
    <section class="hero">
      <div class="copy">
        <h1 class="wordmark">{t("app.name")}</h1>
        <p class="tagline">{t("app.tagline")}</p>
      </div>
      <picture class="kv">
        <source media="(max-width: 760px)" srcset="/kv-mobile.jpg" />
        <img src="/kv.jpg" alt={t("home.kvAlt")} width="1280" height="853" loading="eager" fetchpriority="high" />
      </picture>
    </section>
  );
  const heroBoot = <script>{raw(HERO_COMPACT)}</script>;
  return c.html(
    <StationPage stationKey="mine" title={t("app.name")} label={stationLabel({ kind: "mine" }, "", lang)} lang={lang} listener={listener} path="/" voice={listener.voice} dial={listener.dial} grow={false} hideName top={<>{hero}{heroBoot}</>} send letter={letter} og={og}>
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
          <section class="recent-episodes">
            <h2>{t("episode.archive")}</h2>
            <ul class="up-next">
              {heard.map((e) => (
                <EpisodeRow id={e.id} kind={e.kind as Item["kind"] | null} title={e.title} creator={e.creator} imageUrl={e.imageUrl} sender={e.sender ? senderLine(e.sender, lang) : null} lang={lang} />
              ))}
            </ul>
            <a href="/episodes">{t("home.seeAll")}</a>
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
