import { type Context, Hono } from "hono";
import { BookmarkletHelp, bookmarkletCode } from "../../views/bookmarklet";
import { ItemCard, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { elicitQuestions } from "../claude/elicit";
import { isInHistory, listFavorites, listHistory, listImported, upsertHistory } from "../db/history";
import { findItemsByExternalIds, getItem } from "../db/items";
import type { Env } from "../env";
import { requireSignin } from "../auth/require-signin";
import { tFor } from "../i18n/t";
import { type ItemDraft, resolveUrl, searchByText } from "../resolve";
import { searchRateLimit } from "../security/rate-limit";
import type { Item, Listener } from "../types";

type AppEnv = { Bindings: Env; Variables: Variables };

/** A search hit and where choosing it goes: the stored item when there is one, else its own link, resolved again. */
export type SearchResult = { item: ItemDraft; href: string };

export type PutPageProps = {
  listener: Listener;
  bookmarklet: string | null;
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
  /** The text the favourites are narrowed by. */
  pick?: string;
  /** The title searched for, and what came back (absent when nothing was searched or the search was refused). */
  q?: string;
  results?: SearchResult[];
};

const SEARCH_RESULTS = 10;
const MAX_QUERY = 200;
const LISTED = 30;
/** With a filter, more rows are read so the filter reaches past the first page. */
const LISTED_FOR_FILTER = 200;

function PickLink({ item }: { item: Item }) {
  return (
    <a href={`/put?itemId=${item.id}`}>
      {item.imageUrl && <img src={item.imageUrl} alt="" width="48" height="48" loading="lazy" />}
      <span class="history-title">{item.title}</span> <span class="history-creator">{item.creator}</span>
    </a>
  );
}

function Favorites({ listener, history, picker, pick }: Pick<PutPageProps, "listener" | "history" | "picker" | "pick">) {
  const t = tFor(listener.lang);
  const lists = picker ?? { favorites: [], top: [], recent: [] };
  const any = lists.favorites.length + lists.top.length + lists.recent.length + (history?.length ?? 0) > 0;
  if (!any && !pick) return null;
  return (
    <section class="put-way put-history">
      <h3>{t("put.fromFavorites")}</h3>
      <form method="get" action="/put" class="put-filter">
        <label>
          <span>{t("put.filterFavorites")}</span>
          <input type="search" name="pick" value={pick ?? ""} />
        </label>
        <button type="submit">{t("put.filterSubmit")}</button>
      </form>
      {!any && <p class="muted">{t("search.none")}</p>}
      {lists.favorites.length > 0 && (
        <section class="put-favorites">
          <h4>{t("put.favorites")}</h4>
          <ul>{lists.favorites.map((item) => <li><PickLink item={item} /></li>)}</ul>
        </section>
      )}
      {(lists.top.length > 0 || lists.recent.length > 0) && <h4>{t("put.fromHistory")}</h4>}
      {([["put.imported.top", lists.top], ["put.imported.recent", lists.recent]] as const).map(([key, items]) =>
        items.length > 0 ? (
          <section class="put-imported-group">
            <h5>{t(key)}</h5>
            <ul>
              {items.map((item) => (
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
      {history && history.length > 0 && (
        <section>
          <h4>{t("put.fromHistory")}</h4>
          <ul>{history.map((item) => <li><PickLink item={item} /></li>)}</ul>
        </section>
      )}
    </section>
  );
}

function Search({ listener, q, results }: Pick<PutPageProps, "listener" | "q" | "results">) {
  const t = tFor(listener.lang);
  return (
    <section class="put-way put-search" id="search">
      <h3>{t("put.searchTitle")}</h3>
      {listener.googleSub === null ? (
        <p class="put-signin">
          {t("put.searchNeedsSignin")} <a href={`/auth/google?next=${encodeURIComponent("/put")}`}>{t("signin.google")}</a>
        </p>
      ) : (
        <>
          <form method="get" action="/put" class="put-search-form">
            <input type="search" name="q" value={q ?? ""} placeholder={t("put.searchPlaceholder")} aria-label={t("put.searchTitle")} maxlength={MAX_QUERY} required />
            <button type="submit">{t("put.searchSubmit")}</button>
          </form>
          {results && results.length === 0 && <p class="muted">{t("search.none")}</p>}
          {results && results.length > 0 && (
            <ul class="put-results">
              {results.map(({ item, href }) => (
                <li>
                  <a href={href}>
                    <ItemCard item={item} heading="h4" lang={listener.lang} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function PutPage(props: PutPageProps) {
  const { listener, bookmarklet, card, itemId, url, body, error, history, questions = [], imported, picker, pick, q, results } = props;
  const lang = listener.lang;
  const t = tFor(lang);
  const here = itemId ? `/put?itemId=${itemId}` : url ? `/put?url=${encodeURIComponent(url)}` : "/put";
  const chosen = Boolean(card || itemId);
  return (
    <Layout title={t("put.title")} lang={lang} listener={listener} path={here}>
      <main class="put">
        <h1>{t("put.title")}</h1>
        {error && <p class="form-error" role="alert">{error}</p>}
        {imported && <p class="put-imported" role="status">{t("put.imported")}</p>}
        <section class="panel put-choose">
          <h2>{t("put.choose")}</h2>
          {card && <ItemCard item={card} heading="h3" lang={lang} />}
          <section class="put-way">
            <h3>{t("put.pasteUrl")}</h3>
            <form method="get" action="/put" class="put-url">
              <label>
                <span>{t("put.url")}</span>
                <input type="url" name="url" value={url ?? ""} />
              </label>
              <button type="submit">{t("put.resolve")}</button>
            </form>
          </section>
          {!chosen && <Favorites listener={listener} history={history} picker={picker} pick={pick} />}
          <Search listener={listener} q={q} results={results} />
        </section>
        {chosen && (
          <section class="panel put-write">
            <h2>{t("put.write")}</h2>
            {listener.googleSub === null ? (
              <p class="put-signin" role="status">
                {t("signin.needed")} <a href={`/auth/google?next=${encodeURIComponent(here)}`}>{t("signin.google")}</a>
              </p>
            ) : (
              <form method="post" action="/letters" class="put-form">
                {questions.length > 0 && (
                  <section class="put-questions">
                    <h3>{t("put.questions")}</h3>
                    <ul>
                      {questions.map((question) => (
                        <li>{question}</li>
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
          </section>
        )}
        <section class="panel put-bookmarklet">
          <h2>{t("bookmarklet.title")}</h2>
          <BookmarkletHelp code={bookmarklet} lang={lang} />
        </section>
      </main>
    </Layout>
  );
}

/** Stored hits link to the item; the rest link to their own page, which /put?url= resolves to the same work. */
async function searchResults(env: Env, q: string): Promise<SearchResult[]> {
  const drafts = await searchByText(q, "any", env, SEARCH_RESULTS);
  const firstId = (d: ItemDraft): [string, string] | undefined => Object.entries(d.externalIds)[0];
  const pairs = drafts.flatMap((d) => {
    const id = firstId(d);
    return id ? [id] : [];
  });
  const stored = pairs.length > 0 ? await findItemsByExternalIds(env.DB, pairs) : [];
  return drafts.flatMap((d): SearchResult[] => {
    const [key, value] = firstId(d) ?? [];
    const hit = key ? stored.find((i) => i.externalIds[key] === value) : undefined;
    if (hit) return [{ item: hit, href: `/put?itemId=${encodeURIComponent(hit.id)}` }];
    const out = Object.values(d.outLinks)[0];
    return out ? [{ item: d, href: `/put?url=${encodeURIComponent(out)}` }] : [];
  });
}

const matches = (pick: string) => (item: Item) => !pick || `${item.title}\n${item.creator}`.toLowerCase().includes(pick.toLowerCase());

const queryOf = (c: Context<AppEnv>, name: string): string => (c.req.query(name) ?? "").trim().slice(0, MAX_QUERY);

export const put = new Hono<AppEnv>();

const limitSearch = searchRateLimit((c) => {
  const listener = c.get("listener");
  return c.html(<PutPage listener={listener} bookmarklet={bookmarkletCode(c.env.PUBLIC_ORIGIN)} card={null} q={queryOf(c, "q")} error={tFor(listener.lang)("search.tooMany")} />, 429);
});

put.get("/put", limitSearch, async (c) => {
  const listener = c.get("listener");
  const t = tFor(listener.lang);
  const bookmarklet = bookmarkletCode(c.env.PUBLIC_ORIGIN);
  const itemId = c.req.query("itemId");
  const url = c.req.query("url")?.trim();
  if (itemId) {
    const item = await getItem(c.env.DB, itemId);
    if (!item) return c.html(<PutPage listener={listener} bookmarklet={bookmarklet} card={null} error={t("put.notFound")} />, 404);
    const questions = (await isInHistory(c.env.DB, listener.id, item.id)) ? await elicitQuestions(c.env, item, listener) : [];
    return c.html(<PutPage listener={listener} bookmarklet={bookmarklet} card={item} itemId={item.id} questions={questions} />);
  }
  if (url) {
    const draft = await resolveUrl(url, c.env);
    return c.html(<PutPage listener={listener} bookmarklet={bookmarklet} card={draft} url={url} error={draft ? undefined : t("put.notFound")} />);
  }
  const pick = queryOf(c, "pick");
  const q = queryOf(c, "q");
  const signedIn = listener.googleSub !== null;
  // The query goes to the providers only; it is never logged.
  const results = q && signedIn ? await searchResults(c.env, q) : undefined;
  const imported = c.req.query("imported") === "1";
  const limit = pick ? LISTED_FOR_FILTER : LISTED;
  const keep = <T extends { item: Item }>(rows: T[]) => rows.map((h) => h.item).filter(matches(pick)).slice(0, LISTED);
  if (signedIn) {
    const [favorites, fromSpotify] = await Promise.all([listFavorites(c.env.DB, listener.id, limit), listImported(c.env.DB, listener.id, limit)]);
    const picker = { favorites: keep(favorites), top: keep(fromSpotify.top), recent: keep(fromSpotify.recent) };
    return c.html(<PutPage listener={listener} bookmarklet={bookmarklet} card={null} picker={picker} pick={pick} q={q} results={results} imported={imported} />);
  }
  const history = keep(await listHistory(c.env.DB, listener.id, limit));
  return c.html(<PutPage listener={listener} bookmarklet={bookmarklet} card={null} history={history} pick={pick} q={q} imported={imported} />);
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
