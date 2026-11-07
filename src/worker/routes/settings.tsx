import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { updateListener } from "../db/listeners";
import { COUNTRIES, REGIONS } from "../geo/places";
import { isValidRegion, placeLabel } from "../geo/place-label";
import { looksLikeContact } from "../program/pii-patterns";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { currentPath } from "../auth/require-signin";
import type { Listener } from "../types";

/** The DJ says radio names and places aloud, so they may not be an address, a phone number or a url. */
const notContact = (s: string) => !looksLikeContact(s);

const fields = z.object({
  radioName: z.string().trim().max(20).refine(notContact),
  /** Empty means no place. */
  placeCountry: z.string().trim().refine((v) => v === "" || COUNTRIES.some((c) => c.code === v)).default(""),
  placeRegion: z.string().trim().default(""),
});
/** The region has to belong to the chosen country. */
const schema = fields.refine((v) => isValidRegion(v.placeCountry, v.placeRegion));

type FormValues = Pick<Listener, "radioName" | "place" | "placeCountry" | "placeRegion" | "lang">;

function SettingsPage(props: { values: FormValues; listener: Listener; path: string; listenerId: string; spotifyConnected: boolean; spotifyFailed?: boolean; signinFailed?: boolean; saved?: boolean; invalid?: boolean }) {
  const { values, listener, path, listenerId, spotifyConnected, spotifyFailed, signinFailed, saved, invalid } = props;
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
            <span>{t("settings.radioName")}</span>
            <input type="text" name="radioName" maxlength={20} value={values.radioName} />
            <small>{t("settings.radioNameHint")}</small>
          </label>
          <fieldset class="settings-place">
            <legend>{t("settings.place")}</legend>
            <small>{t("settings.placeHelp")}</small>
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
          <button type="submit">{t("settings.save")}</button>
        </form>

        {listener.googleSub !== null && (
          <p class="settings-station-link">
            <a href="/me#radio">{t("settings.stationOnMe")}</a>
          </p>
        )}

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

        <p class="muted">
          {t("settings.listenerId")}: <code>{listenerId}</code>
        </p>
      </main>
    </Layout>
  );
}

type SettingsContext = Context<{ Bindings: Env; Variables: Variables }>;

export const settings = new Hono<{ Bindings: Env; Variables: Variables }>();

settings.get("/settings", (c) => {
  const listener = c.get("listener");
  return c.html(
    <SettingsPage values={listener} listener={listener} path={currentPath(c)} listenerId={listener.id} spotifyConnected={listener.spotifyRefreshToken !== null} spotifyFailed={c.req.query("spotify") === "failed"} signinFailed={c.req.query("signin") === "failed"} saved={c.req.query("saved") === "1"} />,
  );
});

settings.post(
  "/settings",
  zValidator("form", schema, (result, ctx) => {
    if (result.success) return;
    const c = ctx as SettingsContext;
    const listener = c.get("listener");
    return c.html(<SettingsPage values={listener} listener={listener} path={currentPath(c)} listenerId={listener.id} spotifyConnected={listener.spotifyRefreshToken !== null} invalid />, 422);
  }),
  async (c) => {
    const listener = c.get("listener");
    const { placeCountry, placeRegion, ...other } = c.req.valid("form");
    // An old free-text place stays until a country is chosen; choosing "none" afterwards clears it.
    // The public radio is set on /me; nothing posted here touches it.
    await updateListener(c.env.DB, listener.id, {
      ...other,
      ...(placeCountry === "" && listener.placeCountry === null
        ? {}
        : { placeCountry: placeCountry || null, placeRegion: placeRegion || null, place: placeLabel(placeCountry || null, placeRegion || null, "ja") }),
    });
    return c.redirect("/settings?saved=1", 303);
  },
);
