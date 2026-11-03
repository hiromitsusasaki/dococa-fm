import { Hono } from "hono";
import { raw } from "hono/html";
import { ItemCard } from "../../views/components";
import { whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { countEpisodesToday, getEpisode, insertEpisode, listEpisodes } from "../db/episodes";
import { getItem } from "../db/items";
import type { Env } from "../env";
import { t } from "../i18n/t";
import { buildEpisode } from "../program/build";
import type { Episode, Item, Listener, ScriptLine } from "../types";

export const episodes = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_DAILY_LIMIT = 10;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function dailyLimit(env: Env): number {
  const n = Number.parseInt(env.EPISODE_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

type Made = { ok: true; id: string } | { ok: false; reason: "limit" | "unavailable" };

/** Limit check, build, store. Failures are logged by error name only: report details can quote lines. */
async function makeEpisode(env: Env, listener: Listener): Promise<Made> {
  if ((await countEpisodesToday(env.DB, listener.id)) >= dailyLimit(env)) return { ok: false, reason: "limit" };
  try {
    const episode = await insertEpisode(env.DB, await buildEpisode(env, env.DB, listener));
    return { ok: true, id: episode.id };
  } catch (e) {
    console.error(`[dococa] episode build failed: ${e instanceof Error ? e.name : "unknown"}`);
    return { ok: false, reason: "unavailable" };
  }
}

function MessagePage({ message }: { message: string }) {
  return (
    <Layout title={t("episode.title")}>
      <main class="episode-page">
        <p role="alert">{message}</p>
        <p>
          <a href="/">{t("episode.home")}</a>
        </p>
      </main>
    </Layout>
  );
}

/** JSON inside a script element: every `<` becomes a unicode escape so no `</script>` or `<!--` can occur. */
const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

const readerOf = (l: Extract<ScriptLine, { type: "letter" }>): string =>
  l.kind === "found" ? (l.sourceAuthor ?? "") : whoOf(l);

episodes.post("/episodes", async (c) => {
  const made = await makeEpisode(c.env, c.get("listener"));
  if (made.ok) return c.redirect(`/episodes/${made.id}`, 303);
  return c.html(<MessagePage message={t(made.reason === "limit" ? "episode.limit" : "episode.unavailable")} />, made.reason === "limit" ? 429 : 503);
});

episodes.get("/episodes", async (c) => {
  const list = await listEpisodes(c.env.DB, c.get("listener").id, 50);
  const rows = await Promise.all(
    list.map(async (e) => {
      const first = e.segments[0] ? await getItem(c.env.DB, e.segments[0].itemId) : null;
      return { id: e.id, date: new Date(Date.parse(e.createdAt) + JST_OFFSET_MS).toISOString().slice(0, 10), title: first?.title ?? t("episode.untitled") };
    }),
  );
  return c.html(
    <Layout title={t("episode.archive")}>
      <main class="archive">
        <h1>{t("episode.archive")}</h1>
        {rows.length === 0 ? (
          <p class="muted">{t("episode.archiveEmpty")}</p>
        ) : (
          <ul class="archive-list">
            {rows.map((r) => (
              <li>
                <a href={`/episodes/${r.id}`}>
                  <time>{r.date}</time> {r.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </main>
    </Layout>,
  );
});

/** Only the listener's own episodes exist as far as this route is concerned. */
async function ownEpisode(c: { env: Env; get: (k: "listener") => Listener }, id: string): Promise<Episode | null> {
  const e = await getEpisode(c.env.DB, id);
  return e && e.listenerId === c.get("listener").id ? e : null;
}

episodes.get("/episodes/:id", async (c) => {
  const param = c.req.param("id");
  const asJson = param.endsWith(".json");
  const episode = await ownEpisode(c, asJson ? param.slice(0, -".json".length) : param);
  if (!episode) return c.notFound();
  if (asJson) return c.json(episode);

  const listener = c.get("listener");
  const rows = (
    await Promise.all(
      episode.segments.map(async (s) => {
        const item: Item | null = await getItem(c.env.DB, s.itemId);
        return item ? [{ item, slot: s.slot, readers: s.lines.filter((l): l is Extract<ScriptLine, { type: "letter" }> => l.type === "letter") }] : [];
      }),
    )
  ).flat();
  return c.html(
    <Layout title={t("episode.title")} script>
      <main class="episode-page">
        <div id="player" data-episode-id={episode.id} data-voice={listener.voice} data-next-url={`/episodes/${episode.id}/next`} data-tts-url=""></div>
        <ol class="program">
          {rows.map((r) => (
            <li>
              <p class="slot">{t(`slot.${r.slot}`)}</p>
              <a href={`/items/${r.item.id}`}>
                <ItemCard item={r.item} heading="h2" />
              </a>
              {r.readers.map((l) => (
                <p class="letter-who">{readerOf(l)}</p>
              ))}
            </li>
          ))}
        </ol>
        <p>
          <a href="/episodes">{t("episode.archive")}</a>
        </p>
        <script type="application/json" id="episode-json">
          {raw(jsonForScript(episode))}
        </script>
      </main>
    </Layout>,
  );
});

episodes.post("/episodes/:id/next", async (c) => {
  if (!(await ownEpisode(c, c.req.param("id")))) return c.notFound();
  const made = await makeEpisode(c.env, c.get("listener"));
  if (made.ok) return c.json({ id: made.id });
  return c.json({ error: made.reason }, made.reason === "limit" ? 429 : 503);
});
