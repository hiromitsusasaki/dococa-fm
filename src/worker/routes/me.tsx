import { Hono } from "hono";
import { ItemCard, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import { currentPath, requireSignin } from "../auth/require-signin";
import type { Variables } from "../auth/session";
import { listFavorites } from "../db/history";
import { getItemsByIds } from "../db/items";
import { listLettersByListener, listReactionsToListener } from "../db/letters";
import type { Env } from "../env";
import { displayText } from "../letters/display";
import { tFor } from "../i18n/t";
import { stationUrl } from "../program/station";

const FAVORITES_LIMIT = 20;
const REACTIONS_LIMIT = 50;

export const me = new Hono<{ Bindings: Env; Variables: Variables }>();

me.get("/me", requireSignin, async (c) => {
  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  const favorites = await listFavorites(c.env.DB, listener.id, FAVORITES_LIMIT);
  const sent = await listLettersByListener(c.env.DB, listener.id);
  // The query pages through the ids in chunks, each newest first; merge them before cutting.
  const reactions = (await listReactionsToListener(c.env.DB, listener.id, [...new Set(sent.map((l) => l.itemId))]))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, REACTIONS_LIMIT);
  const items = await getItemsByIds(c.env.DB, reactions.map((r) => r.itemId));
  const publicUrl = listener.stationPublic && listener.stationSlug ? stationUrl(c.env, listener.stationSlug) : null;
  return c.html(
    <Layout title={t("me.title")} lang={lang} listener={listener} path={currentPath(c)}>
      <main class="me">
        <h1>{t("me.title")}</h1>
        <section class="me-favorites">
          <h2>{t("me.favorites")}</h2>
          <ul>
            {favorites.map(({ item }) => (
              <li>
                <a href={`/items/${item.id}`}>
                  <ItemCard item={item} heading="h3" lang={lang} />
                </a>
                <a href={`/put?itemId=${item.id}`}>{t("put.title")}</a>
              </li>
            ))}
          </ul>
        </section>
        <section class="me-reactions">
          <h2>{t("me.reactions")}</h2>
          {reactions.length === 0 ? (
            <p class="muted">{t("me.nobody")}</p>
          ) : (
            <ul>
              {reactions.map((r) => (
                <li>
                  <p class="letter-who">{whoOf(r, lang)}</p>
                  <p>{t(r.kind === "watashimo" ? "reaction.watashimo" : "me.reply")}</p>
                  {r.kind === "reply" && <p class="letter-body">{displayText(r, lang).main}</p>}
                  <p class="muted">
                    <a href={`/items/${r.itemId}`}>{items.get(r.itemId)?.title ?? ""}</a>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section class="me-station">
          <h2>{t("me.station")}</h2>
          {publicUrl ? (
            <p>
              <a href={publicUrl}>{publicUrl}</a>
            </p>
          ) : (
            <p>
              <a href="/settings">{t("settings.station")}</a>
            </p>
          )}
        </section>
        <form method="post" action="/auth/signout">
          <button type="submit">{t("signin.out")}</button>
        </form>
      </main>
    </Layout>,
  );
});
