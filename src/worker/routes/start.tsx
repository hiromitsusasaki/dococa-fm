import { Hono } from "hono";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { requireSignin } from "../auth/require-signin";
import { embedItems } from "../ai/embed";
import { defer } from "../defer";
import { upsertHistory } from "../db/history";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { createLetter } from "../letters/create";
import type { Listener } from "../types";
import { type ItemDraft, resolveOrCreateMany, resolveUrl, searchByText } from "../resolve";

const SLOTS = [1, 2, 3] as const;
const MAX_FIELD = 300;

type Values = Record<`fav${1 | 2 | 3}` | `note${1 | 2 | 3}`, string>;

function StartPage({ values, error, listener }: { values?: Partial<Values>; error?: boolean; listener: Listener }) {
  const lang = listener.lang;
  const t = tFor(lang);
  return (
    <Layout title={t("start.title")} lang={lang} listener={listener} path="/start">
      <main class="start">
        <h1>{t("start.title")}</h1>
        <p>{t("start.lead")}</p>
        {error && (
          <div class="form-error" role="alert">
            <p>{t("start.none")}</p>
            <p>{t("start.hint")}</p>
          </div>
        )}
        <form method="post" action="/start" class="start-form">
          {SLOTS.map((n) => (
            <fieldset>
              <legend>{t("start.favorite", { n: String(n) })}</legend>
              <input type="text" name={`fav${n}`} maxlength={MAX_FIELD} value={values?.[`fav${n}`] ?? ""} placeholder={t("start.favoritePlaceholder")} required={n === 1} aria-label={t("start.favorite", { n: String(n) })} />
              <input type="text" name={`note${n}`} maxlength={200} value={values?.[`note${n}`] ?? ""} placeholder={t("start.note")} aria-label={t("start.note")} />
            </fieldset>
          ))}
          <button type="submit">{t("start.submit")}</button>
        </form>
      </main>
    </Layout>
  );
}

/** The url a field means, or null for a title: an explicit scheme, or `host.tld/path` (a bare "Mr.Children" stays a title). */
function urlOf(q: string): string | null {
  if (/^https?:\/\/\S+$/i.test(q)) return q;
  return /^[^\s/]+\.[^\s/]+\/\S*$/.test(q) ? `https://${q}` : null;
}

/** A url goes through the url resolver only (a blocked one is unresolved, never searched); a title is searched and the first hit wins. */
async function resolveFavorite(q: string, env: Env): Promise<ItemDraft | null> {
  const url = urlOf(q);
  if (url) return resolveUrl(url, env);
  return (await searchByText(q, "any", env))[0] ?? null;
}

export const start = new Hono<{ Bindings: Env; Variables: Variables }>();

start.get("/start", requireSignin, (c) => c.html(<StartPage listener={c.get("listener")} />));

start.post("/start", requireSignin, async (c) => {
  const listener = c.get("listener");
  const form = await c.req.parseBody();
  const field = (k: string) => (typeof form[k] === "string" ? (form[k] as string).trim().slice(0, MAX_FIELD) : "");
  const values = Object.fromEntries(SLOTS.flatMap((n) => [[`fav${n}`, field(`fav${n}`)], [`note${n}`, field(`note${n}`)]])) as Values;

  const resolved = await Promise.all(SLOTS.map(async (n) => (values[`fav${n}`] ? { n, draft: await resolveFavorite(values[`fav${n}`], c.env) } : { n, draft: null })));
  const found = resolved.filter((r): r is { n: 1 | 2 | 3; draft: ItemDraft } => r.draft !== null);
  if (found.length === 0) return c.html(<StartPage values={values} error listener={listener} />, 422);

  // One lookup and one insert for all three; two drafts that are the same work resolve to one item.
  const stored = await resolveOrCreateMany(c.env.DB, found.map((f) => f.draft));
  const items = found.map(({ n }, i) => ({ n, item: stored[i]! }));
  defer(c, embedItems(c.env, c.env.DB, stored.map((i) => i.id)));
  await upsertHistory(c.env.DB, items.map(({ item }) => ({ listenerId: listener.id, itemId: item.id, source: "manual", occurredAt: null, rank: null })));

  // Sequential: the letter checks (duplicates, limits) read what the last one wrote.
  // A one-liner that fails its judgement is skipped; it never stops the first episode.
  for (const { n, item } of items) {
    const body = values[`note${n}`];
    if (!body) continue;
    const result = await createLetter(c.env, c.env.DB, listener, { itemId: item.id, body }, { item });
    if (!result.ok) console.warn("[dococa] start one-liner skipped", result.key, result.reason ?? "");
  }
  return c.redirect("/stations/mine", 303);
});
