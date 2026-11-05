import { Hono } from "hono";
import { ItemCard } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { listRecentItems } from "../db/items";
import { hasActivity } from "../db/listeners";
import type { Env } from "../env";
import { tFor } from "../i18n/t";

export const home = new Hono<{ Bindings: Env; Variables: Variables }>();

home.get("/", async (c) => {
  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  const [recent, active] = await Promise.all([listRecentItems(c.env.DB, 6), hasActivity(c.env.DB, listener.id)]);
  const isNew = !active;
  return c.html(
    <Layout title={t("app.name")} lang={lang}>
      <main class="home">
        <h1>{t("app.name")}</h1>
        <p>{t("app.tagline")}</p>
        {isNew && (
          <p>
            <a href="/start">{t("home.start")}</a>
          </p>
        )}
        {isNew ? (
          <p>
            <a class="button" href="/start">{t("home.listen")}</a>
          </p>
        ) : (
          <form method="post" action="/episodes">
            <button type="submit" class="button">{t("home.listen")}</button>
          </form>
        )}
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
      </main>
    </Layout>,
  );
});
