import { Hono } from "hono";
import { ItemCard } from "../../views/components";
import type { Variables } from "../auth/session";
import { listRecentItems } from "../db/items";
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
  const [recent, active] = await Promise.all([listRecentItems(c.env.DB, 6), hasActivity(c.env.DB, listener.id)]);
  return c.html(
    <StationPage stationKey="world" title={t("app.name")} label={stationLabel({ kind: "world" }, "", lang)} lang={lang} voice={listener.voice} dial={listener.dial} grow={false} intro={<p class="tune-in">{t("home.tuneIn")}</p>}>
      <section class="home">
        <p>{t("app.tagline")}</p>
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
            <ul class="recent-items">
              {recent.map((item) => (
                <li>
                  <a href={`/items/${item.id}`}>
                    <ItemCard item={item} heading="h2" lang={lang} />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </section>
    </StationPage>,
  );
});
