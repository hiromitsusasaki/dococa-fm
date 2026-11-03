import { Hono } from "hono";
import { ItemCard } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { listHistory } from "../db/history";
import { listRecentItems } from "../db/items";
import { listLettersByListener } from "../db/letters";
import type { Env } from "../env";
import { t } from "../i18n/t";

export const home = new Hono<{ Bindings: Env; Variables: Variables }>();

home.get("/", async (c) => {
  const listener = c.get("listener");
  const [recent, history, own] = await Promise.all([
    listRecentItems(c.env.DB, 6),
    listHistory(c.env.DB, listener.id, 1),
    listLettersByListener(c.env.DB, listener.id),
  ]);
  const isNew = history.length === 0 && own.length === 0;
  return c.html(
    <Layout title={t("app.name")}>
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
                    <ItemCard item={item} heading="h2" />
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
