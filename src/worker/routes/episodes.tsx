import { type Context, Hono } from "hono";
import { raw } from "hono/html";
import { ItemCard, whoOf } from "../../views/components";
import { Layout } from "../../views/layout";
import { currentPath } from "../auth/require-signin";
import type { Variables } from "../auth/session";
import { getVerifiedEpisode, listArchive } from "../db/episodes";
import { getItemsByIds } from "../db/items";
import type { Env } from "../env";
import { ja } from "../i18n/ja";
import { type Lang, tFor } from "../i18n/t";
import { makeEpisode } from "../program/create";
import { readNextBody } from "./next-body";
import { toPlayerView } from "../program/player-view";
import { loadPublicEpisode, segmentReading } from "../program/stored";
import type { Episode, Listener, ScriptLine } from "../types";

export const episodes = new Hono<{ Bindings: Env; Variables: Variables }>();

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function MessagePage({ message, start, listener, path }: { message: string; start?: boolean; listener: Listener; path: string }) {
  const lang = listener.lang;
  const t = tFor(lang);
  return (
    <Layout title={t("episode.title")} lang={lang} listener={listener} path={path}>
      <main class="episode-page">
        <p role="alert">{message}</p>
        {start && (
          <p>
            <a class="button" href="/start">{t("home.start")}</a>
          </p>
        )}
        <p>
          <a href="/">{t("episode.home")}</a>
        </p>
      </main>
    </Layout>
  );
}

/** JSON inside a script element: every `<` becomes a unicode escape so no `</script>` or `<!--` can occur. */
export const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/** What the client player needs to know: the labels it shows, as `t()` values, since `t()` is server-only. */
const PLAYER_KEY = /^(player\.|out\.|letter\.(who|whoPlace|whoDemo|showOriginal)|lang\.code$|station\.(dial|limit|failed)$|episode\.continueOnStation$|listener\.(?:anonymous|demo)$)/;
const playerStrings = (lang: Lang): Record<string, string> =>
  Object.fromEntries(Object.keys(ja).filter((k) => PLAYER_KEY.test(k)).map((k) => [k, tFor(lang)(k as keyof typeof ja)]));

const readerOf = (l: Extract<ScriptLine, { type: "letter" }>, lang: Lang): string =>
  l.kind === "found" ? (l.sourceAuthor ?? "") : whoOf(l, lang);

/** Builds the listener's next episode and answers with the redirect, or the limit / unavailable page. Shared with POST /start. */
export const startEpisode = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const lang = c.get("listener").lang;
  const t = tFor(lang);
  // A form post carries no body we read; listening starts here, so the DJ opens unless told otherwise.
  const body = (await readNextBody(c.req.raw)) ?? {};
  const made = await makeEpisode(c.env, c.get("listener"), { ...body, first: body.first ?? true });
  if (made.ok) return c.redirect(`/episodes/${made.id}`, 303);
  if (made.reason === "empty") return c.html(<MessagePage message={t("episode.empty")} start listener={c.get("listener")} path={currentPath(c)} />, 200);
  return c.html(<MessagePage message={t(made.reason === "limit" ? "episode.limit" : "episode.unavailable")} listener={c.get("listener")} path={currentPath(c)} />, made.reason === "limit" ? 429 : 503);
};

episodes.post("/episodes", startEpisode);

episodes.get("/episodes", async (c) => {
  const lang = c.get("listener").lang;
  const t = tFor(lang);
  const rows = (await listArchive(c.env.DB, c.get("listener").id, 50)).map((e) => ({
    id: e.id,
    date: new Date(Date.parse(e.createdAt) + JST_OFFSET_MS).toISOString().slice(0, 10),
    title: e.title ?? t("episode.untitled"),
  }));
  return c.html(
    <Layout title={t("episode.archive")} lang={lang} listener={c.get("listener")} path={currentPath(c)}>
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

/** Only the listener's own verified episodes exist as far as this route is concerned. */
async function ownEpisode(c: { env: Env; get: (k: "listener") => Listener }, id: string): Promise<Episode | null> {
  const e = await getVerifiedEpisode(c.env.DB, id);
  return e && e.listenerId === c.get("listener").id ? e : null;
}

episodes.get("/episodes/:id", async (c) => {
  const param = c.req.param("id");
  const asJson = param.endsWith(".json");
  const episode = await ownEpisode(c, asJson ? param.slice(0, -".json".length) : param);
  // Only the builder stores verified rows; reading verified rows only is a second lock, not the first.
  if (!episode) return c.notFound();
  // Letters rejected or taken down since the episode was made are left out of every exit.
  const loaded = await loadPublicEpisode(c.env.DB, episode, c.get("listener").lang);
  const { segments, originals } = loaded;
  // `station` can carry another listener's id (`public:<id>`) and `report` is the verifier's internals; neither leaves the server.
  if (asJson) {
    const { station: _station, report: _report, ...shown } = episode;
    return c.json({ ...shown, segments, originals });
  }

  const listener = c.get("listener");
  const lang = listener.lang;
  const t = tFor(lang);
  // `?letter=` (the listen-again link) starts at the segment that reads it in the public view, which shifts when
  // an earlier letter is taken down; an old `?seg=` link, then 0, are the fallbacks.
  const letter = c.req.query("letter");
  const byLetter = letter ? segmentReading(segments, letter) : -1;
  const seg = Number(c.req.query("seg") ?? "");
  const startSeg = byLetter >= 0 ? byLetter : Number.isInteger(seg) && seg >= 0 && seg < segments.length ? seg : 0;
  const stored = await getItemsByIds(c.env.DB, segments.map((s) => s.itemId));
  const rows = segments.flatMap((s) => {
    const item = stored.get(s.itemId);
    if (!item) return [];
    return [{ item, slot: s.slot, readers: s.lines.filter((l): l is Extract<ScriptLine, { type: "letter" }> => l.type === "letter") }];
  });
  // The page already says whether the cloud voice is on (data-tts-url), so the embedded json keeps its old shape.
  const { cloudTts: _cloudTts, ...pageJson } = toPlayerView(episode, loaded, stored);
  return c.html(
    <Layout title={t("episode.title")} script="player" lang={lang} listener={listener} path={currentPath(c)}>
      <main class="episode-page">
        <div id="player" data-episode-id={episode.id} data-voice={listener.voice} data-tts-url={episode.cloudTts ? "/tts" : ""} data-listens-url="/listens" data-dial={String(listener.dial)} data-start-seg={String(startSeg)}></div>
        <ol class="program">
          {rows.map((r) => (
            <li>
              <p class="slot">{t(`slot.${r.slot}`)}</p>
              <a href={`/items/${r.item.id}`}>
                <ItemCard item={r.item} heading="h2" lang={lang} />
              </a>
              {r.readers.map((l) => (
                <p class="letter-who">{readerOf(l, lang)}</p>
              ))}
            </li>
          ))}
        </ol>
        <p>
          <a href="/episodes">{t("episode.archive")}</a>
        </p>
        <script type="application/json" id="episode-json">
          {raw(jsonForScript(pageJson))}
        </script>
        <script type="application/json" id="player-i18n">
          {raw(jsonForScript(playerStrings(lang)))}
        </script>
      </main>
    </Layout>,
  );
});

episodes.post("/episodes/:id/next", async (c) => {
  if (!(await ownEpisode(c, c.req.param("id")))) return c.notFound();
  const body = await readNextBody(c.req.raw);
  if (!body) return c.json({ error: "bad request" }, 400);
  const made = await makeEpisode(c.env, c.get("listener"), { ...body, first: body.first === true });
  if (made.ok) return c.json({ id: made.id });
  return c.json({ error: made.reason }, made.reason === "limit" ? 429 : made.reason === "empty" ? 409 : 503);
});
