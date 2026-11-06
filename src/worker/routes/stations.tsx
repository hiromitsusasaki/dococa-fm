import { Hono } from "hono";
import { raw as rawHtml } from "hono/html";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { getVerifiedEpisode, latestVerifiedEpisodeOn } from "../db/episodes";
import { listHistory } from "../db/history";
import { getListenerBySlug } from "../db/listeners";
import type { Env } from "../env";
import { ja } from "../i18n/ja";
import { type Lang, tFor } from "../i18n/t";
import { makeEpisode } from "../program/create";
import { readNextBody } from "./next-body";
import { playerView } from "../program/player-view";
import { type StationKey, parseStationKey, stationColumn, stationLabel, stationUrl } from "../program/station";
import { jsonForScript } from "./episodes";
import { currentPath } from "../auth/require-signin";
import type { Listener } from "../types";

export const stations = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The route's key as a station, with the owner's name for the label. Null when it is not a station a listener can tune to. */
async function resolve({ DB: db, PUBLIC_ORIGIN }: Pick<Env, "DB" | "PUBLIC_ORIGIN">, raw: string): Promise<{ key: StationKey; ownerName: string; url?: string } | null> {
  const parsed = parseStationKey(raw);
  if (!parsed) return null;
  if (parsed.kind !== "public") return { key: parsed, ownerName: "" };
  const owner = await getListenerBySlug(db, parsed.slug);
  return owner ? { key: { kind: "public", ownerId: owner.id }, ownerName: owner.radioName, url: stationUrl({ PUBLIC_ORIGIN }, parsed.slug) } : null;
}

/** What the station player needs to know: the labels it shows, as `t()` values, since `t()` is server-only. */
const STATION_KEY = /^(station\.|player\.|out\.|kind\.|letter\.(who|whoPlace|whoDemo|showOriginal)|lang\.code$|listener\.(?:anonymous|demo)$)/;
const stationStrings = (lang: Lang): Record<string, string> =>
  Object.fromEntries(Object.keys(ja).filter((k) => STATION_KEY.test(k)).map((k) => [k, tFor(lang)(k as keyof typeof ja)]));

export type StationPageProps = {
  /** The route's key: `world`, `mine` or `s:<slug>`. */
  stationKey: string;
  label: string;
  lang: Lang;
  listener: Listener;
  /** The page's own path, for the header's sign-in link. */
  path: string;
  voice: string;
  dial: number;
  /** A `mine` station with no history yet: the player shows how to start instead of tuning. */
  grow: boolean;
  /** The page title when it differs from the station label (the home page is titled by the app). */
  title?: string;
  /** Link-preview tags (a public station is meant to be shared). */
  og?: { title: string; description: string; url: string };
  /** Extra content under the player (the home page's links). */
  children?: unknown;
  /** The home page has no heading of its own yet (the hero brings it); other stations show their name. */
  hideName?: boolean;
  /** Content above the player (the home page's hero). */
  top?: unknown;
  /** A letter the listener came to hear (`/stations/mine?letter=`): the first request asks for it. */
  letter?: string;
};

/** The station screen: the player mounts into `#station` and takes everything it needs from its data attributes. */
export function StationPage({ stationKey, label, lang, listener, path, voice, dial, grow, title, og, children, hideName, top, letter }: StationPageProps) {
  return (
    <Layout title={title ?? label} script="station" lang={lang} listener={listener} path={path} og={og}>
      <main class="station-page">
        {top}
        {!hideName && <h1 class="station-name">{label}</h1>}
        <div
          id="station"
          data-station-key={stationKey}
          data-label={label}
          data-next-url={`/stations/${stationKey}/next`}
          data-resume-url={`/stations/${stationKey}.json`}
          data-tts-url="/tts"
          data-listens-url="/listens"
          data-voice={voice}
          data-dial={String(dial)}
          data-grow={grow ? "1" : "0"}
          data-letter={letter}
        ></div>
        <script type="application/json" id="station-i18n">
          {rawHtml(jsonForScript(stationStrings(lang)))}
        </script>
        {children}
      </main>
    </Layout>
  );
}

stations.post("/stations/:key/next", async (c) => {
  const raw = c.req.param("key");
  const listener = c.get("listener");
  const station = await resolve(c.env, raw);
  if (!station) return c.json({ error: "station" }, 404);
  const body = await readNextBody(c.req.raw);
  if (!body) return c.json({ error: "bad request" }, 400);
  // A letter link is for the listener's own station; the world and public stations pick from their own pools.
  const { letterId, ...rest } = body;
  const made = await makeEpisode(c.env, listener, { ...rest, ...(station.key.kind === "mine" && letterId ? { letterId } : {}), station: station.key });
  if (!made.ok) return c.json({ error: made.reason }, made.reason === "limit" ? 429 : made.reason === "empty" ? 409 : 503);
  const stored = await getVerifiedEpisode(c.env.DB, made.id);
  if (!stored) return c.json({ error: "unavailable" }, 503);
  return c.json({
    episode: await playerView(c.env.DB, stored, listener.lang),
    station: { key: raw, label: stationLabel(station.key, station.ownerName, listener.lang) },
  });
});

stations.get("/stations/:key", async (c) => {
  const param = c.req.param("key");
  const asJson = param.endsWith(".json");
  const raw = asJson ? param.slice(0, -".json".length) : param;
  const listener = c.get("listener");
  const station = await resolve(c.env, raw);
  if (!station) return asJson ? c.json({ error: "station" }, 404) : c.notFound();
  const label = stationLabel(station.key, station.ownerName, listener.lang);

  if (!asJson) {
    const grow = station.key.kind === "mine" && (await listHistory(c.env.DB, listener.id, 1)).length === 0;
    const asked = c.req.query("letter") ?? "";
    const letter = station.key.kind === "mine" && asked.length > 0 && asked.length <= 100 ? asked : undefined;
    return c.html(<StationPage letter={letter} stationKey={raw} label={label} lang={listener.lang} listener={listener} path={currentPath(c)} voice={listener.voice} dial={listener.dial} grow={grow} og={station.url ? { title: label, description: tFor(listener.lang)("app.tagline"), url: station.url } : undefined} />);
  }

  // Resume after a reload. With `?id=` it is that very episode, if it is this listener's, was made on this station and
  // is in the listener's current language (after a switch, the old language's episode is not resumed) (the player stores the one it was playing, which is not always the newest: the next one may already be made).
  // Without it, or when that one is not found, the player asks for the latest verified episode on this station.
  const wanted = c.req.query("id");
  const column = stationColumn(station.key);
  const picked = wanted ? await getVerifiedEpisode(c.env.DB, wanted) : null;
  if (wanted && !(picked && picked.listenerId === listener.id && picked.station === column && picked.lang === listener.lang)) return c.body(null, 204);
  const latest = picked ?? (await latestVerifiedEpisodeOn(c.env.DB, listener.id, column, listener.lang));
  if (!latest) return c.body(null, 204);
  return c.json({
    episode: await playerView(c.env.DB, latest, listener.lang),
    station: { key: raw, label },
  });
});
