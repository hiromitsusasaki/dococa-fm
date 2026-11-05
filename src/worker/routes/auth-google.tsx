import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Layout } from "../../views/layout";
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

/** A same-site absolute path only; anything else would make the callback an open redirect. */
function safeNext(raw: string | undefined): string {
  if (!raw || raw.length > 200 || !raw.startsWith("/") || raw.includes("//") || raw.includes("\\")) return DEFAULT_NEXT;
  return raw;
}

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

export const authGoogle = new Hono<{ Bindings: Env; Variables: Variables }>();

authGoogle.get("/auth/google", (c) => {
  if (!c.env.GOOGLE_OAUTH_CLIENT_ID) {
    const t = tFor(c.get("listener").lang);
    return c.html(
      <Layout title={t("signin.unavailable")} lang={c.get("listener").lang}>
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
  const next = safeNext(c.req.query("next"));
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
  const [state, nonce, encodedNext] = (getCookie(c, OAUTH_COOKIE) ?? "").split(".");
  deleteCookie(c, OAUTH_COOKIE, { path: OAUTH_PATH });
  const code = c.req.query("code");
  if (!c.env.GOOGLE_OAUTH_CLIENT_ID || !state || !nonce || !code || c.req.query("state") !== state) return c.redirect(FAILED, 303);

  const tokens = await exchangeGoogleCode(c.env, code);
  const profile = tokens && parseIdToken(tokens.idToken, c.env, nonce);
  if (!profile) return c.redirect(FAILED, 303);

  let next = DEFAULT_NEXT;
  try {
    next = safeNext(decodeURIComponent(encodedNext ?? ""));
  } catch {
    // A malformed escape falls back to the default.
  }

  const current = c.get("listener");
  const existing = await getListenerByGoogleSub(c.env.DB, profile.sub);
  if (existing && existing.id !== current.id) {
    // The anonymous listener we leave behind stays as it was.
    await setSessionCookie(c, existing.id);
  } else {
    const displayName = profile.name || profile.email.split("@")[0] || "";
    await updateListener(c.env.DB, current.id, {
      googleSub: profile.sub,
      displayName: displayName || undefined,
      radioName: current.radioName || displayName || undefined,
    });
  }
  return c.redirect(next, 303);
});

authGoogle.post("/auth/signout", (c) => {
  clearSessionCookie(c);
  return c.redirect("/", 303);
});
