import { Hono } from "hono";
import { LetterCard, senderLine } from "../../views/components";
import type { Variables } from "../auth/session";
import { type ArchiveSender, listArchive } from "../db/episodes";
import { listRecentPublicLetters } from "../db/letters";
import type { Env } from "../env";
import { type Lang, tFor } from "../i18n/t";
import { stationLabel } from "../program/station";
import { StationPage } from "./stations";

export const home = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Programmes the listener heard, newest first, on the home. */
const RECENT_EPISODES = 3;

/** A heard programme's line: its first work and who sent the first letter (a found voice by its source's author). */
function episodeLine(title: string | null, sender: ArchiveSender | null, lang: Lang): string {
  const t = tFor(lang);
  const work = title ?? t("episode.untitled");
  return sender ? `${work} · ${senderLine(sender, lang)}` : work;
}

home.get("/", async (c) => {
  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  const [recent, heard] = await Promise.all([listRecentPublicLetters(c.env.DB, 6), listArchive(c.env.DB, listener.id, RECENT_EPISODES)]);
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
  return c.html(
    <StationPage stationKey="mine" title={t("app.name")} label={stationLabel({ kind: "mine" }, "", lang)} lang={lang} listener={listener} path="/" voice={listener.voice} dial={listener.dial} grow={false} hideName top={hero}>
      <section class="home">
        <p>
          <a class="button" href="/put" data-open-send>{t("home.put")}</a>
        </p>
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
        <section class="recent-episodes">
          <h2>{t("episode.archive")}</h2>
          {heard.length > 0 && (
            <ul>
              {heard.map((e) => (
                <li>
                  <a href={`/episodes/${e.id}`}>{episodeLine(e.title, e.sender, lang)}</a>
                </li>
              ))}
            </ul>
          )}
          <a href="/episodes">{t("home.seeAll")}</a>
        </section>
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
