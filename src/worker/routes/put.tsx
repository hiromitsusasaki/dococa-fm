import { Hono } from "hono";
import { ItemCard, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { elicitQuestions } from "../claude/elicit";
import { isInHistory, listFavorites, listHistory, listImported, upsertHistory } from "../db/history";
import { getItem } from "../db/items";
import type { Env } from "../env";
import { requireSignin } from "../auth/require-signin";
import { tFor } from "../i18n/t";
import { type ItemDraft, resolveUrl } from "../resolve";
import type { Item, Listener } from "../types";

export type PutPageProps = {
  listener: Listener;
  card: ItemDraft | null;
  itemId?: string;
  url?: string;
  body?: string;
  error?: string;
  history?: Item[];
  questions?: string[];
  imported?: boolean;
  /** Signed-in only: what the listener chose, and what Spotify brought in, in two groups. */
  picker?: { favorites: Item[]; top: Item[]; recent: Item[] };
};

function PickLink({ item }: { item: Item }) {
  return (
    <a href={`/put?itemId=${item.id}`}>
      {item.imageUrl && <img src={item.imageUrl} alt="" width="48" height="48" loading="lazy" />}
      <span class="history-title">{item.title}</span> <span class="history-creator">{item.creator}</span>
    </a>
  );
}

export function PutPage({ listener, card, itemId, url, body, error, history = [], questions = [], imported, picker }: PutPageProps) {
  const lang = listener.lang;
  const t = tFor(lang);
  const here = itemId ? `/put?itemId=${itemId}` : url ? `/put?url=${encodeURIComponent(url)}` : "/put";
  return (
    <Layout title={t("put.title")} lang={lang} listener={listener} path={here}>
      <main class="put">
        <h1>{t("put.title")}</h1>
        {error && <p class="form-error" role="alert">{error}</p>}
        {imported && <p class="put-imported" role="status">{t("put.imported")}</p>}
        {card && <ItemCard item={card} heading="h2" lang={lang} />}
        {!card && url && (
          <p class="muted">
            <a href="/start">{t("put.search")}</a>
          </p>
        )}
        <form method="get" action="/put" class="put-url">
          <label>
            <span>{t("put.url")}</span>
            <input type="url" name="url" value={url ?? ""} />
          </label>
          <button type="submit">{t("put.resolve")}</button>
        </form>
        {!card && picker && (picker.favorites.length > 0 || picker.top.length > 0 || picker.recent.length > 0) && (
          <section class="put-history">
            {picker.favorites.length > 0 && (
              <section class="put-favorites">
                <h2>{t("put.favorites")}</h2>
                <ul>{picker.favorites.map((item) => <li><PickLink item={item} /></li>)}</ul>
              </section>
            )}
            {(picker.top.length > 0 || picker.recent.length > 0) && <h2>{t("put.fromHistory")}</h2>}
            {[["put.imported.top", picker.top], ["put.imported.recent", picker.recent]].map(([key, items]) =>
              (items as Item[]).length > 0 ? (
                <section class="put-imported-group">
                  <h3>{t(key as "put.imported.top")}</h3>
                  <ul>
                    {(items as Item[]).map((item) => (
                      <li>
                        <PickLink item={item} />
                        <form method="post" action="/put/register" class="put-register">
                          <input type="hidden" name="itemId" value={item.id} />
                          <button type="submit">{t("put.register")}</button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
          </section>
        )}
        {!card && !picker && history.length > 0 && (
          <section class="put-history">
            <h2>{t("put.fromHistory")}</h2>
            <ul>
              {history.map((item) => (
                <li>
                  <a href={`/put?itemId=${item.id}`}>
                    {item.imageUrl && <img src={item.imageUrl} alt="" width="48" height="48" loading="lazy" />}
                    <span class="history-title">{item.title}</span> <span class="history-creator">{item.creator}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        {listener.spotifyRefreshToken === null && (
          <p class="put-connect">
            <a href="/auth/spotify">{t("put.connectSpotify")}</a>
          </p>
        )}
        {(card || itemId) && listener.googleSub === null && (
          <p class="put-signin" role="status">
            {t("signin.needed")} <a href={`/auth/google?next=${encodeURIComponent(here)}`}>{t("signin.google")}</a>
          </p>
        )}
        {(card || itemId) && listener.googleSub !== null && (
          <form method="post" action="/letters" class="put-form">
            {questions.length > 0 && (
              <section class="put-questions">
                <h2>{t("put.questions")}</h2>
                <ul>
                  {questions.map((q) => (
                    <li>{q}</li>
                  ))}
                </ul>
              </section>
            )}
            {itemId ? <input type="hidden" name="itemId" value={itemId} /> : <input type="hidden" name="url" value={url ?? ""} />}
            <label>
              <span>{t("put.body")}</span>
              <textarea name="body" maxlength={200} rows={5} required>{body ?? ""}</textarea>
              <small>{t("put.bodyHelp")}</small>
            </label>
            <p class="put-from">
              {t("put.from")}: {whoOf(listener, lang)} <a href="/settings">{t("put.editSettings")}</a>
              <br />
              <small>{t("put.fromHelp")}</small>
            </p>
            <button type="submit">{t("put.submit")}</button>
          </form>
        )}
        <section class="put-bookmarklet">
          <p>{t("put.bookmarklet")}</p>
          <a href="/bookmarklet">{t("put.bookmarkletLink")}</a>
        </section>
      </main>
    </Layout>
  );
}

export const put = new Hono<{ Bindings: Env; Variables: Variables }>();

put.get("/put", async (c) => {
  const listener = c.get("listener");
  const t = tFor(listener.lang);
  const itemId = c.req.query("itemId");
  const url = c.req.query("url")?.trim();
  if (itemId) {
    const item = await getItem(c.env.DB, itemId);
    if (!item) return c.html(<PutPage listener={listener} card={null} error={t("put.notFound")} />, 404);
    const questions = (await isInHistory(c.env.DB, listener.id, item.id)) ? await elicitQuestions(c.env, item, listener) : [];
    return c.html(<PutPage listener={listener} card={item} itemId={item.id} questions={questions} />);
  }
  if (url) {
    const draft = await resolveUrl(url, c.env);
    return c.html(<PutPage listener={listener} card={draft} url={url} error={draft ? undefined : t("put.notFound")} />);
  }
  if (listener.googleSub !== null) {
    const [favorites, imported] = await Promise.all([listFavorites(c.env.DB, listener.id, 30), listImported(c.env.DB, listener.id, 30)]);
    const picker = { favorites: favorites.map((h) => h.item), top: imported.top.map((h) => h.item), recent: imported.recent.map((h) => h.item) };
    return c.html(<PutPage listener={listener} card={null} picker={picker} imported={c.req.query("imported") === "1"} />);
  }
  const history = (await listHistory(c.env.DB, listener.id, 30)).map((h) => h.item);
  return c.html(<PutPage listener={listener} card={null} history={history} imported={c.req.query("imported") === "1"} />);
});

/** Makes an imported candidate a favourite (it then shows on the public station and /me), then on to writing the letter. */
put.post("/put/register", requireSignin, async (c) => {
  const listener = c.get("listener");
  const form = await c.req.parseBody();
  const itemId = typeof form.itemId === "string" ? form.itemId : "";
  if (!itemId || !(await isInHistory(c.env.DB, listener.id, itemId))) return c.notFound();
  await upsertHistory(c.env.DB, [{ listenerId: listener.id, itemId, source: "manual", occurredAt: null, rank: null }]);
  return c.redirect(`/put?itemId=${encodeURIComponent(itemId)}`, 303);
});
