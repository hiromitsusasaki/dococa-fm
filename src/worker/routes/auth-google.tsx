import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Layout } from "../../views/layout";
import { currentPath } from "../auth/require-signin";
import { exchangeGoogleCode, googleAuthorizeUrl, parseIdToken } from "../auth/google";
import { type Variables, clearSessionCookie, setSessionCookie } from "../auth/session";
import { getListenerByGoogleSub, updateListener } from "../db/listeners";
import type { Env } from "../env";
import { tFor } from "../i18n/t";

const OAUTH_COOKIE = "dfm_oauth";
const OAUTH_PATH = "/auth/google";
const OAUTH_MAX_AGE = 600;
const DEFAULT_NEXT = "/me";
const FAILED = "/settings?signin=failed";

/**
 * A same-site absolute path only; anything else would make the callback an open redirect. Printable ASCII only,
 * because browsers strip tabs and newlines from a Location value (`/%09/evil.com` would become `//evil.com`).
 */
function safeNext(raw: string | undefined, publicOrigin: string): string {
  if (!raw || raw.length > 200 || !/^\/(?!\/)[\x21-\x7e]*$/.test(raw) || raw.includes("\\") || /%(?:[01][0-9a-f]|7f)/i.test(raw)) return DEFAULT_NEXT;
  try {
    const u = new URL(raw, publicOrigin);
    if (u.origin !== new URL(publicOrigin).origin) return DEFAULT_NEXT;
    const next = u.pathname + u.search;
    return next.startsWith("//") ? DEFAULT_NEXT : next;
  } catch {
    return DEFAULT_NEXT;
  }
}

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export const authGoogle = new Hono<{ Bindings: Env; Variables: Variables }>();

authGoogle.get("/auth/google", (c) => {
  if (!c.env.GOOGLE_OAUTH_CLIENT_ID) {
    const t = tFor(c.get("listener").lang);
    return c.html(
      <Layout title={t("signin.unavailable")} lang={c.get("listener").lang} listener={c.get("listener")} path={currentPath(c)}>
        <main class="settings">
          <p role="status">{t("signin.unavailable")}</p>
          <p>
            <a href="/">{t("settings.title")}</a>
          </p>
        </main>
      </Layout>,
      503,
    );
  }
  const state = randomHex();
  const nonce = randomHex();
  const next = safeNext(c.req.query("next"), c.env.PUBLIC_ORIGIN);
  setCookie(c, OAUTH_COOKIE, `${state}.${nonce}.${encodeURIComponent(next)}`, {
    httpOnly: true,
    sameSite: "Lax",
    path: OAUTH_PATH,
    maxAge: OAUTH_MAX_AGE,
    secure: c.env.PUBLIC_ORIGIN.startsWith("https://"),
  });
  return c.redirect(googleAuthorizeUrl(c.env, state, nonce), 302);
});

authGoogle.get("/auth/google/callback", async (c) => {
  // `next` may itself contain dots, so everything after the second dot belongs to it.
  const [state, nonce, ...rest] = (getCookie(c, OAUTH_COOKIE) ?? "").split(".");
  deleteCookie(c, OAUTH_COOKIE, { path: OAUTH_PATH });
  const code = c.req.query("code");
  if (!c.env.GOOGLE_OAUTH_CLIENT_ID || !state || !nonce || !code || c.req.query("state") !== state) return c.redirect(FAILED, 303);

  const tokens = await exchangeGoogleCode(c.env, code);
  const profile = tokens && parseIdToken(tokens.idToken, c.env, nonce);
  if (!profile) return c.redirect(FAILED, 303);

  let next = DEFAULT_NEXT;
  try {
    next = safeNext(decodeURIComponent(rest.join(".")), c.env.PUBLIC_ORIGIN);
  } catch {
    // A malformed escape falls back to the default.
  }

  // The session cookie is a deterministic HMAC of the listener id, so it does not rotate when an account is bound
  // or switched. A callback without a valid dfm_sid also leaves an orphan anonymous listener row behind.
  const current = c.get("listener");
  const existing = await getListenerByGoogleSub(c.env.DB, profile.sub);
  if (existing) {
    // The anonymous listener we leave behind stays as it was.
    if (existing.id !== current.id) await setSessionCookie(c, existing.id);
  } else {
    // Never overwrite a listener that is already bound to another Google account.
    if (current.googleSub !== null) return c.redirect(FAILED, 303);
    const displayName = profile.name || profile.email.split("@")[0] || undefined;
    try {
      await updateListener(c.env.DB, current.id, { googleSub: profile.sub, displayName, radioName: current.radioName || displayName });
    } catch {
      // google_sub is UNIQUE: someone bound the same account between our lookup and this write.
      const winner = await getListenerByGoogleSub(c.env.DB, profile.sub);
      if (!winner) return c.redirect(FAILED, 303);
      await setSessionCookie(c, winner.id);
    }
  }
  return c.redirect(next, 303);
});

authGoogle.post("/auth/signout", (c) => {
  clearSessionCookie(c);
  return c.redirect("/", 303);
});
