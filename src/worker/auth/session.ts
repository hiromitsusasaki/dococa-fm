import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createListener, getListener } from "../db/listeners";
import type { Env } from "../env";
import type { Listener } from "../types";
import { langFromAcceptLanguage } from "../i18n/t";
import { toBase64Url } from "./crypto";

export type Variables = { listener: Listener };

export const SESSION_COOKIE = "dfm_sid";
const ONE_YEAR_SECONDS = 31536000;

const encoder = new TextEncoder();

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

const EXEMPT_PREFIXES = ["/admin", "/assets", "/src"];
const EXEMPT_PATHS = new Set(["/healthz", "/app.css", "/favicon.ico", "/manifest.webmanifest", "/icon.svg"]);
const BED_PATH = /^\/bed-\d+\.mp3$/;

/** Token-authenticated routes and static assets must not mint a listener per request. */
export function isSessionExempt(path: string): boolean {
  if (EXEMPT_PATHS.has(path) || BED_PATH.test(path)) return true;
  return EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

type SessionContext = Context<{ Bindings: Env; Variables: Variables }>;

const cookieOptions = (env: Env) => ({
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
  secure: env.PUBLIC_ORIGIN.startsWith("https://"),
});

export async function setSessionCookie(c: SessionContext, listenerId: string): Promise<void> {
  setCookie(c, SESSION_COOKIE, await signSession(listenerId, c.env.SESSION_SECRET), { ...cookieOptions(c.env), maxAge: ONE_YEAR_SECONDS });
}

export function clearSessionCookie(c: SessionContext): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c.env));
}

export const sessionMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  if (isSessionExempt(c.req.path)) return next();

  const id = await verifySession(getCookie(c, SESSION_COOKIE), c.env.SESSION_SECRET);
  let listener = id ? await getListener(c.env.DB, id) : null;
  if (!listener) {
    listener = await createListener(c.env.DB, { lang: langFromAcceptLanguage(c.req.header("accept-language")) });
    await setSessionCookie(c, listener.id);
  }
  c.set("listener", listener);
  return next();
};

let warnedMissingSecret = false;

/** An empty SESSION_SECRET would make every cookie request throw inside importKey; answer plainly instead, and log once. */
export const requireSessionSecret: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (isSessionExempt(c.req.path) || c.env.SESSION_SECRET) return next();
  if (!warnedMissingSecret) {
    warnedMissingSecret = true;
    console.error("[dococa] SESSION_SECRET is empty; refusing requests that need a session");
  }
  return c.text("Server is not configured", 500);
};
