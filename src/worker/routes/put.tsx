import { Hono } from "hono";
import { ItemCard, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { elicitQuestions } from "../claude/elicit";
import { isInHistory, listHistory } from "../db/history";
import { getItem } from "../db/items";
import type { Env } from "../env";
import { t } from "../i18n/t";
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
};

export function PutPage({ listener, card, itemId, url, body, error, history = [], questions = [], imported }: PutPageProps) {
  return (
    <Layout title={t("put.title")}>
      <main class="put">
        <h1>{t("put.title")}</h1>
        {error && <p class="form-error" role="alert">{error}</p>}
        {imported && <p class="put-imported" role="status">{t("put.imported")}</p>}
        {card && <ItemCard item={card} heading="h2" />}
        {!card && url && (
          <p class="muted">
            <a href="/">{t("put.search")}</a>
          </p>
        )}
        <form method="get" action="/put" class="put-url">
          <label>
            <span>{t("put.url")}</span>
            <input type="url" name="url" value={url ?? ""} />
          </label>
          <button type="submit">{t("put.resolve")}</button>
        </form>
        {!card && history.length > 0 && (
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
        {(card || itemId) && (
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
              {t("put.from")}: {whoOf(listener)} <a href="/settings">{t("put.editSettings")}</a>
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
  const history = (await listHistory(c.env.DB, listener.id, 30)).map((h) => h.item);
  return c.html(<PutPage listener={listener} card={null} history={history} imported={c.req.query("imported") === "1"} />);
});
