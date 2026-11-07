import { Hono } from "hono";
import { raw } from "hono/html";
import { ItemCard, LetterSource, LetterText, ReactionForms, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import { currentPath, requireSignin } from "../auth/require-signin";
import type { Variables } from "../auth/session";
import { listFavorites } from "../db/history";
import { getItemsByIds } from "../db/items";
import { listHeardLetters } from "../db/listens";
import { listRecentReactionsToListener } from "../db/letters";
import type { Env } from "../env";
import { displayText } from "../letters/display";
import { tFor } from "../i18n/t";
import { ensureStationSlug, stationUrl } from "../program/station";

const FAVORITES_LIMIT = 20;
const REACTIONS_LIMIT = 50;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const jstDate = (iso: string): string => new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);

export const me = new Hono<{ Bindings: Env; Variables: Variables }>();

me.get("/me", requireSignin, async (c) => {
  const signedIn = c.get("listener");
  // As on /settings: a listener signed in before addresses were assigned gets one here; a failure renders without it.
  const listener = !signedIn.stationSlug ? { ...signedIn, stationSlug: await ensureStationSlug(c.env.DB, signedIn).catch(() => null) } : signedIn;
  const lang = listener.lang;
  const t = tFor(lang);
  const favorites = await listFavorites(c.env.DB, listener.id, FAVORITES_LIMIT);
  const reactions = await listRecentReactionsToListener(c.env.DB, listener.id, REACTIONS_LIMIT);
  const items = await getItemsByIds(c.env.DB, reactions.map((r) => r.itemId));
  const heard = await listHeardLetters(c.env.DB, listener.id);
  const publicUrl = listener.stationPublic && listener.stationSlug ? stationUrl(c.env, listener.stationSlug) : null;
  // Shown once: the script drops the query, so a reload does not repeat it. A listener who is already public has no news in it.
  const welcome = c.req.query("welcome") === "1" && listener.stationSlug && !listener.stationPublic ? stationUrl(c.env, listener.stationSlug) : null;
  return c.html(
    <Layout title={t("me.title")} lang={lang} listener={listener} path={currentPath(c)}>
      <main class="me">
        <h1>{t("me.title")}</h1>
        {welcome && (
          <>
            <p class="notice" role="status">{t("me.welcome", { url: welcome })}</p>
            <script>{raw(`try{history.replaceState(null,"",location.pathname)}catch(e){}`)}</script>
          </>
        )}
        {!listener.radioName && (
          <p class="muted">
            {t("me.radioNameHint")} <a href="/settings">{t("settings.title")}</a>
          </p>
        )}
        <section class="panel me-favorites">
          <h2>{t("me.favorites")}</h2>
          <ul class="me-cards">
            {favorites.map(({ item }) => (
              <li>
                <a class="me-card-link" href={`/items/${item.id}`}>
                  <ItemCard item={item} heading="h3" lang={lang} art />
                </a>
                <a class="me-card-put" href={`/put?itemId=${item.id}`}>{t("put.title")}</a>
              </li>
            ))}
          </ul>
        </section>
        <section class="panel me-heard">
          <h2>{t("me.heard")}</h2>
          {heard.length === 0 ? (
            <p class="muted">{t("me.heardNone")}</p>
          ) : (
            <ul class="me-list">
              {heard.map((h) => (
                <li>
                  <a class="me-card-link" href={`/items/${h.item.id}`}>
                    <ItemCard item={h.item} heading="h3" lang={lang} />
                  </a>
                  <LetterText letter={h.letter} lang={lang} />
                  {h.letter.kind === "found" ? <LetterSource letter={h.letter} lang={lang} /> : <p class="letter-who">{whoOf(h.letter, lang)}</p>}
                  <p class="muted">{t("me.heardOn", { date: jstDate(h.heardAt) })}</p>
                  <p>
                    <a href={`/episodes/${h.episodeId}?letter=${encodeURIComponent(h.letter.id)}`}>{t("me.replay")}</a>
                  </p>
                  <div class="letter-actions">
                    <ReactionForms letterId={h.letter.id} itemId={h.item.id} lang={lang} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section class="panel me-reactions">
          <h2>{t("me.reactions")}</h2>
          {reactions.length === 0 ? (
            <p class="muted">{t("me.nobody")}</p>
          ) : (
            <ul class="me-list">
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
        <section class="panel me-station">
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
      </main>
    </Layout>,
  );
});
