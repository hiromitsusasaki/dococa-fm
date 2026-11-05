import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Layout } from "../../views/layout";
import type { Variables } from "../auth/session";
import { currentPath, requireSignin } from "../auth/require-signin";
import { authorizeUrl, createPkce, exchangeCode, importSpotifyHistory } from "../auth/spotify";
import { encryptSecret } from "../auth/crypto";
import { updateListener } from "../db/listeners";
import type { Env } from "../env";
import type { Listener } from "../types";
import { tFor } from "../i18n/t";

const PKCE_COOKIE = "dfm_pkce";
const PKCE_PATH = "/auth/spotify";
const PKCE_MAX_AGE = 600;

function Notice({ message, listener, path }: { message: string; listener: Listener; path: string }) {
  const lang = listener.lang;
  const t = tFor(lang);
  return (
    <Layout title={t("settings.spotify")} lang={lang} listener={listener} path={path}>
      <main class="settings">
        <h1>{t("settings.spotify")}</h1>
        <p role="status">{message}</p>
        <p>
          <a href="/settings">{t("settings.title")}</a>
        </p>
      </main>
    </Layout>
  );
}

export const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

auth.get("/auth/spotify", requireSignin, async (c) => {
  const lang = c.get("listener").lang;
  const t = tFor(lang);
  if (!c.env.SPOTIFY_CLIENT_ID) return c.html(<Notice message={t("spotify.notConfigured")} listener={c.get("listener")} path={currentPath(c)} />);
  const pkce = await createPkce();
  setCookie(c, PKCE_COOKIE, `${pkce.state}.${pkce.verifier}`, {
    httpOnly: true,
    sameSite: "Lax",
    path: PKCE_PATH,
    maxAge: PKCE_MAX_AGE,
    secure: c.env.PUBLIC_ORIGIN.startsWith("https://"),
  });
  return c.redirect(authorizeUrl(c.env, pkce.challenge, pkce.state), 302);
});

auth.get("/auth/spotify/callback", requireSignin, async (c) => {
  const lang = c.get("listener").lang;
  const t = tFor(lang);
  if (!c.env.SPOTIFY_CLIENT_ID) return c.html(<Notice message={t("spotify.notConfigured")} listener={c.get("listener")} path={currentPath(c)} />);
  const [state, verifier] = (getCookie(c, PKCE_COOKIE) ?? "").split(".");
  deleteCookie(c, PKCE_COOKIE, { path: PKCE_PATH });
  if (c.req.query("error")) return c.redirect("/settings", 303);
  const code = c.req.query("code");
  if (!state || !verifier || !code || c.req.query("state") !== state) {
    return c.html(<Notice message={t("spotify.badState")} listener={c.get("listener")} path={currentPath(c)} />, 400);
  }
  const tokens = await exchangeCode(c.env, code, verifier);
  if (!tokens) return c.html(<Notice message={t("spotify.failed")} listener={c.get("listener")} path={currentPath(c)} />, 502);

  const listener = c.get("listener");
  const saved = await updateListener(c.env.DB, listener.id, {
    spotifyRefreshToken: await encryptSecret(tokens.refreshToken, c.env.SESSION_SECRET),
  });
  const count = saved ? await importSpotifyHistory(c.env, c.env.DB, saved) : 0;
  // The count only decides where to go; it is never shown.
  return c.redirect(count > 0 ? "/put?imported=1" : "/settings?spotify=failed", 303);
});
