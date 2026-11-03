import { Hono } from "hono";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { upsertHistory } from "../db/history";
import type { Env } from "../env";
import { t } from "../i18n/t";
import { createLetter } from "../letters/create";
import { type ItemDraft, resolveOrCreate, resolveUrl, searchByText } from "../resolve";
import { startEpisode } from "./episodes";

const SLOTS = [1, 2, 3] as const;
const MAX_FIELD = 300;

type Values = Record<`fav${1 | 2 | 3}` | `note${1 | 2 | 3}`, string>;

function StartPage({ values, error }: { values?: Partial<Values>; error?: boolean }) {
  return (
    <Layout title={t("start.title")}>
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

start.get("/start", (c) => c.html(<StartPage />));

start.post("/start", async (c) => {
  const listener = c.get("listener");
  const form = await c.req.parseBody();
  const field = (k: string) => (typeof form[k] === "string" ? (form[k] as string).trim().slice(0, MAX_FIELD) : "");
  const values = Object.fromEntries(SLOTS.flatMap((n) => [[`fav${n}`, field(`fav${n}`)], [`note${n}`, field(`note${n}`)]])) as Values;

  const resolved = await Promise.all(SLOTS.map(async (n) => (values[`fav${n}`] ? { n, draft: await resolveFavorite(values[`fav${n}`], c.env) } : { n, draft: null })));
  const found = resolved.filter((r): r is { n: 1 | 2 | 3; draft: ItemDraft } => r.draft !== null);
  if (found.length === 0) return c.html(<StartPage values={values} error />, 422);

  // Sequential: two drafts can be the same work, and the letter checks (duplicates, limits) read what the last one wrote.
  const items = [];
  for (const { n, draft } of found) items.push({ n, item: await resolveOrCreate(c.env.DB, draft) });
  await upsertHistory(c.env.DB, items.map(({ item }) => ({ listenerId: listener.id, itemId: item.id, source: "manual", occurredAt: null })));

  // A one-liner that fails its judgement is skipped; it never stops the first episode.
  for (const { n, item } of items) {
    const body = values[`note${n}`];
    if (!body) continue;
    const result = await createLetter(c.env, c.env.DB, listener, { itemId: item.id, body });
    if (!result.ok) console.warn("[dococa] start one-liner skipped", result.key, result.reason ?? "");
  }
  return startEpisode(c);
});
