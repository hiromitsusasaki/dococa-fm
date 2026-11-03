import { Hono } from "hono";
import { ItemCard, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { getItem } from "../db/items";
import type { Env } from "../env";
import { t } from "../i18n/t";
import { type ItemDraft, resolveUrl } from "../resolve";
import type { Listener } from "../types";

export type PutPageProps = {
  listener: Listener;
  card: ItemDraft | null;
  itemId?: string;
  url?: string;
  body?: string;
  error?: string;
};

export function PutPage({ listener, card, itemId, url, body, error }: PutPageProps) {
  return (
    <Layout title={t("put.title")}>
      <main class="put">
        <h1>{t("put.title")}</h1>
        {error && <p class="form-error" role="alert">{error}</p>}
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
        {(card || itemId) && (
          <form method="post" action="/letters" class="put-form">
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
    return c.html(<PutPage listener={listener} card={item} itemId={item.id} />);
  }
  if (url) {
    const draft = await resolveUrl(url, c.env);
    return c.html(<PutPage listener={listener} card={draft} url={url} error={draft ? undefined : t("put.notFound")} />);
  }
  return c.html(<PutPage listener={listener} card={null} />);
});
