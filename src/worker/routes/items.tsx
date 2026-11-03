import { Hono } from "hono";
import { ItemCard, LetterList, OutLinks } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { getItem } from "../db/items";
import { listLettersForItem } from "../db/letters";
import type { Env } from "../env";
import { t } from "../i18n/t";

export const items = new Hono<{ Bindings: Env; Variables: Variables }>();

items.get("/items/:id", async (c) => {
  const item = await getItem(c.env.DB, c.req.param("id"));
  if (!item) return c.notFound();
  const letters = await listLettersForItem(c.env.DB, item.id);
  return c.html(
    <Layout title={item.title}>
      <main class="item-page">
        <ItemCard item={item} />
        <OutLinks item={item} />
        <p>
          <a class="button" href={`/put?itemId=${item.id}`}>{t("item.putLetter")}</a>
        </p>
        <LetterList itemId={item.id} letters={letters} />
      </main>
    </Layout>,
  );
});
