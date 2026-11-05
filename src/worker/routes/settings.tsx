import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { newMcpToken, updateListener } from "../db/listeners";
import { looksLikeContact } from "../program/pii-patterns";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { currentPath } from "../auth/require-signin";
import type { Listener } from "../types";

/** The DJ says radio names and places aloud, so they may not be an address, a phone number or a url. */
const notContact = (s: string) => !looksLikeContact(s);

const schema = z.object({
  radioName: z.string().trim().max(20).refine(notContact),
  place: z.string().trim().max(30).refine(notContact),
  voice: z.string().max(200),
  dial: z.coerce.number().min(0).max(1),
  lang: z.enum(["ja", "en"]).optional(),
});

type FormValues = Pick<Listener, "radioName" | "place" | "voice" | "dial" | "lang">;

function SettingsPage(props: { values: FormValues; listener: Listener; path: string; listenerId: string; mcpUrl: string; spotifyConnected: boolean; spotifyFailed?: boolean; signinFailed?: boolean; saved?: boolean; invalid?: boolean }) {
  const { values, listener, path, listenerId, mcpUrl, spotifyConnected, spotifyFailed, signinFailed, saved, invalid } = props;
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
          <label>
            <span>{t("settings.place")}</span>
            <input type="text" name="place" maxlength={30} value={values.place} />
          </label>
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

const mcpUrlOf = (env: Env, listener: Listener) => `${env.PUBLIC_ORIGIN}/mcp/${listener.mcpToken}`;

export const settings = new Hono<{ Bindings: Env; Variables: Variables }>();

settings.get("/settings", (c) => {
  const listener = c.get("listener");
  return c.html(
    <SettingsPage values={listener} listener={listener} path={currentPath(c)} listenerId={listener.id} mcpUrl={mcpUrlOf(c.env, listener)} spotifyConnected={listener.spotifyRefreshToken !== null} spotifyFailed={c.req.query("spotify") === "failed"} signinFailed={c.req.query("signin") === "failed"} saved={c.req.query("saved") === "1"} />,
  );
});

settings.post(
  "/settings",
  zValidator("form", schema, (result, ctx) => {
    if (result.success) return;
    const c = ctx as SettingsContext;
    const listener = c.get("listener");
    return c.html(<SettingsPage values={listener} listener={listener} path={currentPath(c)} listenerId={listener.id} mcpUrl={mcpUrlOf(c.env, listener)} spotifyConnected={listener.spotifyRefreshToken !== null} invalid />, 422);
  }),
  async (c) => {
    await updateListener(c.env.DB, c.get("listener").id, c.req.valid("form"));
    return c.redirect("/settings?saved=1", 303);
  },
);

settings.post("/settings/mcp-token", async (c) => {
  await updateListener(c.env.DB, c.get("listener").id, { mcpToken: newMcpToken() });
  return c.redirect("/settings", 303);
});

/** The player's dial: saves only the dial, effective from the next episode. */
settings.post("/settings/dial", zValidator("form", schema.pick({ dial: true }), (r, c) => (r.success ? undefined : c.body(null, 422))), async (c) => {
  await updateListener(c.env.DB, c.get("listener").id, c.req.valid("form"));
  return c.body(null, 204);
});
