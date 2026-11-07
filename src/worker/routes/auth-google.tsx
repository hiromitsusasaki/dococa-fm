import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Layout } from "../../views/layout";
import { currentPath } from "../auth/require-signin";
import { exchangeGoogleCode, googleAuthorizeUrl, parseIdToken } from "../auth/google";
import { type Variables, clearSessionCookie, setSessionCookie } from "../auth/session";
import { bindGoogleSub, getListenerByGoogleSub } from "../db/listeners";
import type { Env } from "../env";
import { tFor } from "../i18n/t";
import { ensureStationSlug } from "../program/station";
import { safeNext } from "../security/next";
import type { Listener } from "../types";

const OAUTH_COOKIE = "dfm_oauth";
const OAUTH_PATH = "/auth/google";
const OAUTH_MAX_AGE = 600;
const DEFAULT_NEXT = "/me";
const FAILED = "/settings?signin=failed";

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
  const next = safeNext(c.req.query("next"), c.env.PUBLIC_ORIGIN, DEFAULT_NEXT);
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
    next = safeNext(decodeURIComponent(rest.join(".")), c.env.PUBLIC_ORIGIN, DEFAULT_NEXT);
  } catch {
    // A malformed escape falls back to the default.
  }

  // The session cookie is a deterministic HMAC of the listener id, so it does not rotate when an account is bound
  // or switched. A callback without a valid dfm_sid also leaves an orphan anonymous listener row behind.
  const current = c.get("listener");
  const existing = await getListenerByGoogleSub(c.env.DB, profile.sub);
  /** The listener this callback signed in as; every one of them gets a public radio address. */
  let signedIn: Listener;
  /** A listener who just got an account or a public radio address is shown the address once, on /me. */
  let welcome = false;
  if (existing) {
    // The anonymous listener we leave behind stays as it was.
    if (existing.id !== current.id) await setSessionCookie(c, existing.id);
    signedIn = existing;
  } else {
    // Never overwrite a listener that is already bound to another Google account.
    if (current.googleSub !== null) return c.redirect(FAILED, 303);
    // The Google name stays private (header and /me only). The public radio name is only ever what the listener types.
    const displayName = profile.name || profile.email.split("@")[0] || "";
    let bound = false;
    try {
      bound = await bindGoogleSub(c.env.DB, current.id, profile.sub, displayName);
    } catch {
      // google_sub is UNIQUE: someone bound the same account between our lookup and this write.
    }
    if (bound) {
      signedIn = current;
      welcome = true;
    } else {
      // Lost a race: either this account now belongs to a listener (switch to it), or this listener got bound to another account (fail).
      const winner = await getListenerByGoogleSub(c.env.DB, profile.sub);
      if (!winner) return c.redirect(FAILED, 303);
      if (winner.id !== current.id) await setSessionCookie(c, winner.id);
      signedIn = winner;
    }
  }
  try {
    // Listeners who signed in before addresses were assigned get theirs here; one they already have is kept.
    const slug = await ensureStationSlug(c.env.DB, signedIn);
    if (!signedIn.stationSlug && slug) welcome = true;
  } catch {
    // Not fatal: /settings and /me assign the address when they are opened.
  }
  return c.redirect(welcome ? "/me?welcome=1" : next, 303);
});

authGoogle.post("/auth/signout", (c) => {
  clearSessionCookie(c);
  return c.redirect("/", 303);
});
