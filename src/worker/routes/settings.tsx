import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { newMcpToken, updateListener } from "../db/listeners";
import { COUNTRIES, REGIONS } from "../geo/places";
import { isValidRegion, placeLabel } from "../geo/place-label";
import { looksLikeContact } from "../program/pii-patterns";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { SLUG, slugSuffix, stationUrl } from "../program/station";
import { currentPath } from "../auth/require-signin";
import type { Listener } from "../types";

/** The DJ says radio names and places aloud, so they may not be an address, a phone number or a url. */
const notContact = (s: string) => !looksLikeContact(s);

const fields = z.object({
  radioName: z.string().trim().max(20).refine(notContact),
  /** Empty means no place. */
  placeCountry: z.string().trim().refine((v) => v === "" || COUNTRIES.some((c) => c.code === v)).default(""),
  placeRegion: z.string().trim().default(""),
  voice: z.string().max(200),
  dial: z.coerce.number().min(0).max(1),
  lang: z.enum(["ja", "en"]).optional(),
  stationPublic: z.literal("1").optional(),
  /** Empty means "leave it as it is". */
  stationSlug: z.string().trim().toLowerCase().refine((v) => v === "" || SLUG.test(v)).optional(),
});
/** The region has to belong to the chosen country. */
const schema = fields.refine((v) => isValidRegion(v.placeCountry, v.placeRegion));

/** What the station section shows. Absent for an anonymous listener, who cannot publish. */
type StationView = { isPublic: boolean; slug: string; url: string | null; taken?: boolean };

type FormValues = Pick<Listener, "radioName" | "place" | "placeCountry" | "placeRegion" | "voice" | "dial" | "lang">;

function SettingsPage(props: { values: FormValues; listener: Listener; path: string; listenerId: string; mcpUrl: string; spotifyConnected: boolean; spotifyFailed?: boolean; signinFailed?: boolean; saved?: boolean; invalid?: boolean; station?: StationView }) {
  const { values, listener, path, listenerId, mcpUrl, spotifyConnected, spotifyFailed, signinFailed, saved, invalid, station } = props;
  const t = tFor(values.lang);
  return (
    <Layout title={t("settings.title")} lang={values.lang} listener={listener} path={path}>
      <main class="settings">
        <h1>{t("settings.title")}</h1>
        {signinFailed && <p class="settings-error" role="alert">{t("signin.failed")}</p>}
        <p class="settings-name">{values.radioName || t("listener.anonymous")}</p>
        {saved && <p class="settings-note" role="status">{t("settings.saved")}</p>}
        {invalid && <p class="settings-error" role="alert">{t("settings.invalid")}</p>}

        <form method="post" action="/settings" class="settings-form">
          <label>
            <span>{t("settings.lang")}</span>
            <select name="lang">
              <option value="ja" selected={values.lang === "ja"}>日本語</option>
              <option value="en" selected={values.lang === "en"}>English</option>
            </select>
          </label>
          <label>
            <span>{t("settings.radioName")}</span>
            <input type="text" name="radioName" maxlength={20} value={values.radioName} />
          </label>
          <fieldset class="settings-place">
            <legend>{t("settings.place")}</legend>
            <label>
              <span>{t("settings.placeCountry")}</span>
              <select name="placeCountry">
                <option value="" selected={!values.placeCountry}>{t("settings.placeNone")}</option>
                {COUNTRIES.map((c) => (
                  <option value={c.code} selected={values.placeCountry === c.code}>{values.lang === "ja" ? c.ja : c.en}</option>
                ))}
              </select>
              {!values.placeCountry && values.place && <small>{values.place}</small>}
            </label>
            <label>
              <span>{t("settings.placeRegion")}</span>
              <select name="placeRegion">
                <option value="" selected={!values.placeRegion}>{t("settings.placeNone")}</option>
                {(["JP", "US"] as const).map((code) => (
                  <optgroup label={COUNTRIES.find((c) => c.code === code)![values.lang === "ja" ? "ja" : "en"]}>
                    {REGIONS[code].map((r) => (
                      <option value={r.code} selected={values.placeCountry === code && values.placeRegion === r.code}>{values.lang === "ja" ? r.ja : r.en}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </fieldset>
          <label>
            <span>{t("settings.voice")}</span>
            <input type="text" name="voice" maxlength={200} value={values.voice} />
          </label>
          <label>
            <span>{t("settings.dial")}</span>
            <input type="range" name="dial" min="0" max="1" step="0.1" value={String(values.dial)} />
            <output>{String(values.dial)}</output>
            <small>{t("settings.dialHelp")}</small>
          </label>
          {station && (
            <fieldset class="settings-station">
              <legend>{t("settings.station")}</legend>
              <label class="check">
                <input type="checkbox" name="stationPublic" value="1" checked={station.isPublic} />
                <span>{t("settings.stationPublic")}</span>
              </label>
              <label>
                <span>{t("settings.stationSlug")}</span>
                <input type="text" name="stationSlug" maxlength={24} pattern="[a-z0-9-]{3,24}" value={station.slug} autocapitalize="none" spellcheck={false} />
                <small>{t("settings.stationSlugHelp")}</small>
              </label>
              <p class="muted">{t("settings.stationNameHint")}</p>
              {station.taken && <p class="settings-error" role="alert">{t("settings.slugTaken")}</p>}
              {station.url && (
                <p class="settings-station-url">
                  {t("settings.stationUrl")}: {station.isPublic ? <a href={station.url}>{station.url}</a> : <code>{station.url}</code>}
                </p>
              )}
            </fieldset>
          )}
          <button type="submit">{t("settings.save")}</button>
        </form>

        <section class="settings-spotify">
          <h2>{t("settings.spotify")}</h2>
          {spotifyFailed && <p class="settings-error" role="alert">{t("settings.spotifyFailed")}</p>}
          <p>{spotifyConnected ? t("settings.spotifyConnected") : t("settings.spotifyNotConnected")}</p>
          <p>
            <a href="/auth/spotify">{t("settings.spotifyConnect")}</a>
          </p>
          <p class="muted">{t("settings.spotifyDevMode")}</p>
        </section>

        <section class="settings-bookmarklet">
          <h2>{t("settings.bookmarklet")}</h2>
          <p>{t("settings.bookmarkletHelp")}</p>
          <p>
            <a href="/bookmarklet">{t("settings.bookmarkletLink")}</a>
          </p>
        </section>

        <section class="settings-mcp">
          <h2>{t("settings.mcp")}</h2>
          <p>{t("settings.mcpHelp")}</p>
          <input type="text" readonly value={mcpUrl} aria-label={t("settings.mcp")} />
          <form method="post" action="/settings/mcp-token">
            <button type="submit">{t("settings.mcpRegenerate")}</button>
          </form>
          <p class="muted">
            {t("settings.listenerId")}: <code>{listenerId}</code>
          </p>
        </section>
      </main>
    </Layout>
  );
}

type SettingsContext = Context<{ Bindings: Env; Variables: Variables }>;

const stationViewOf = (env: Env, listener: Listener, over: Partial<StationView> = {}): StationView | undefined =>
  listener.googleSub === null
    ? undefined
    : { isPublic: listener.stationPublic, slug: listener.stationSlug ?? "", url: listener.stationSlug ? stationUrl(env, listener.stationSlug) : null, ...over };

const isUniqueViolation = (e: unknown) => String((e as Error)?.message ?? e).includes("station_slug");

const mcpUrlOf = (env: Env, listener: Listener) => `${env.PUBLIC_ORIGIN}/mcp/${listener.mcpToken}`;

export const settings = new Hono<{ Bindings: Env; Variables: Variables }>();

settings.get("/settings", (c) => {
  const listener = c.get("listener");
  return c.html(
    <SettingsPage values={listener} listener={listener} path={currentPath(c)} listenerId={listener.id} mcpUrl={mcpUrlOf(c.env, listener)} spotifyConnected={listener.spotifyRefreshToken !== null} spotifyFailed={c.req.query("spotify") === "failed"} signinFailed={c.req.query("signin") === "failed"} saved={c.req.query("saved") === "1"} station={stationViewOf(c.env, listener)} />,
  );
});

settings.post(
  "/settings",
  zValidator("form", schema, (result, ctx) => {
    if (result.success) return;
    const c = ctx as SettingsContext;
    const listener = c.get("listener");
    return c.html(<SettingsPage values={listener} listener={listener} path={currentPath(c)} listenerId={listener.id} mcpUrl={mcpUrlOf(c.env, listener)} spotifyConnected={listener.spotifyRefreshToken !== null} invalid station={stationViewOf(c.env, listener)} />, 422);
  }),
  async (c) => {
    const listener = c.get("listener");
    const { stationPublic, stationSlug, placeCountry, placeRegion, ...other } = c.req.valid("form");
    // An old free-text place stays until a country is chosen; choosing "none" afterwards clears it.
    const rest = {
      ...other,
      ...(placeCountry === "" && listener.placeCountry === null
        ? {}
        : { placeCountry: placeCountry || null, placeRegion: placeRegion || null, place: placeLabel(placeCountry || null, placeRegion || null, "ja") }),
    };
    // Only a signed-in listener can publish; for anyone else the station fields are dropped without an error.
    if (listener.googleSub === null) {
      await updateListener(c.env.DB, listener.id, rest);
      return c.redirect("/settings?saved=1", 303);
    }

    const isPublic = stationPublic === "1";
    const chosen = stationSlug || null;
    let slug = chosen ?? listener.stationSlug ?? (isPublic ? `radio-${slugSuffix()}` : null);
    // A generated slug that collides gets a random suffix once; a slug the listener chose that collides is theirs to change.
    for (let attempt = 0; ; attempt++) {
      try {
        await updateListener(c.env.DB, listener.id, { ...rest, stationPublic: isPublic, ...(slug ? { stationSlug: slug } : {}) });
        return c.redirect("/settings?saved=1", 303);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        if (chosen || attempt > 0 || !slug) {
          const shown = { ...listener, ...rest, stationPublic: isPublic };
          return c.html(<SettingsPage values={shown} listener={listener} path={currentPath(c)} listenerId={listener.id} mcpUrl={mcpUrlOf(c.env, listener)} spotifyConnected={listener.spotifyRefreshToken !== null} station={stationViewOf(c.env, listener, { isPublic, slug: slug ?? "", url: null, taken: true })} />, 422);
        }
        slug = `${slug.slice(0, 19).replace(/-+$/, "")}-${slugSuffix()}`;
      }
    }
  },
);

settings.post("/settings/mcp-token", async (c) => {
  await updateListener(c.env.DB, c.get("listener").id, { mcpToken: newMcpToken() });
  return c.redirect("/settings", 303);
});

/** The player's dial: saves only the dial, effective from the next episode. */
settings.post("/settings/dial", zValidator("form", fields.pick({ dial: true }), (r, c) => (r.success ? undefined : c.body(null, 422))), async (c) => {
  await updateListener(c.env.DB, c.get("listener").id, c.req.valid("form"));
  return c.body(null, 204);
});
