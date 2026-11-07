import { Hono } from "hono";
import { LetterCard } from "../../views/components";
import type { Variables } from "../auth/session";
import { listRecentPublicLetters } from "../db/letters";
import { hasActivity } from "../db/listeners";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { stationLabel } from "../program/station";
import { StationPage } from "./stations";

export const home = new Hono<{ Bindings: Env; Variables: Variables }>();

home.get("/", async (c) => {
  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  const [recent, active] = await Promise.all([listRecentPublicLetters(c.env.DB, 6), hasActivity(c.env.DB, listener.id)]);
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
        <p>{active ? <a class="button" href="/stations/mine">{t("home.listen")}</a> : <a class="button" href="/start">{t("home.start")}</a>}</p>
        <p>
          <a class="button" href="/put">{t("home.put")}</a>
        </p>
        <p>
          <a href="/episodes">{t("episode.archive")}</a>
        </p>
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
