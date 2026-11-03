import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createListener, getListener } from "../db/listeners";
import type { Env } from "../env";
import type { Listener } from "../types";

export type Variables = { listener: Listener };

export const SESSION_COOKIE = "dfm_sid";
const ONE_YEAR_SECONDS = 31536000;

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(id: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(id))));
}

export async function signSession(id: string, secret: string): Promise<string> {
  return `${id}.${await signature(id, secret)}`;
}

/** Returns the listener id when the cookie is well formed and correctly signed, otherwise null. */
export async function verifySession(cookie: string | undefined, secret: string): Promise<string | null> {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 2) return null;
  const [id, given] = parts;
  if (!id || !given) return null;
  const expected = await signature(id, secret);
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? id : null;
}

const EXEMPT_PREFIXES = ["/admin", "/mcp", "/assets", "/src"];
const EXEMPT_PATHS = new Set(["/healthz", "/app.css", "/favicon.ico", "/manifest.webmanifest"]);

/** Token-authenticated routes and static assets must not mint a listener per request. */
export function isSessionExempt(path: string): boolean {
  if (EXEMPT_PATHS.has(path)) return true;
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export const sessionMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  if (isSessionExempt(c.req.path)) return next();

  const id = await verifySession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  let listener = id ? await getListener(c.env.DB, id) : null;
  if (!listener) {
    listener = await createListener(c.env.DB);
    setCookie(c, SESSION_COOKIE, await signSession(listener.id, c.env.SESSION_SECRET), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: ONE_YEAR_SECONDS,
      secure: c.env.PUBLIC_ORIGIN.startsWith("https://"),
    });
  }
  c.set("listener", listener);
  return next();
};
