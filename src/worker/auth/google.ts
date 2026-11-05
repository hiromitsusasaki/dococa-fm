import type { Env } from "../env";
import { fromBase64Url } from "./crypto";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const redirectUri = (env: Env) => `${env.PUBLIC_ORIGIN}/auth/google/callback`;

export function googleAuthorizeUrl(env: Env, state: string, nonce: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** Only the status is logged: the response may carry tokens. */
export async function exchangeGoogleCode(env: Env, code: string, fetchFn: typeof fetch = fetch): Promise<{ idToken: string } | null> {
  try {
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri(env),
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      console.warn(`[dococa] google token exchange failed: ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { id_token?: unknown };
    return typeof body.id_token === "string" && body.id_token ? { idToken: body.id_token } : null;
  } catch {
    console.warn("[dococa] google token exchange threw");
    return null;
  }
}

/**
 * Reads the claims of an ID token without checking its signature. That is sound here only because the token came
 * straight from Google's token endpoint over TLS in exchange for our own code; never use this on a token that
 * arrived any other way.
 */
export function parseIdToken(idToken: string, env: Env, nonce: string, now: () => number = Date.now): { sub: string; name: string; email: string } | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { iss, aud, exp, sub } = claims;
  if (typeof iss !== "string" || !ISSUERS.has(iss)) return null;
  if (!env.GOOGLE_OAUTH_CLIENT_ID || aud !== env.GOOGLE_OAUTH_CLIENT_ID) return null;
  if (typeof exp !== "number" || exp * 1000 <= now()) return null;
  if (claims.nonce !== nonce) return null;
  if (typeof sub !== "string" || !sub) return null;
  return { sub, name: typeof claims.name === "string" ? claims.name : "", email: typeof claims.email === "string" ? claims.email : "" };
}
