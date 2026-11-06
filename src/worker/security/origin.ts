import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalized(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/**
 * Same-origin only for browser writes. With an `Origin` header it must equal PUBLIC_ORIGIN exactly. Without one,
 * a browser still says `Sec-Fetch-Site`, which must be same-origin or none; a client that sends neither is not a
 * browser (curl, the eval script, tests) and has no ambient cookie to abuse, so it passes.
 * `/admin/*` is Bearer-only, so it is not subject to this.
 */
export const sameOriginOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = c.req.path;
  if (!UNSAFE.has(c.req.method) || path === "/admin" || path.startsWith("/admin/")) return next();
  const origin = c.req.header("origin");
  const site = c.req.header("sec-fetch-site");
  if (origin !== undefined) {
    // Some browsers send `Origin: null` on a same-origin form post under a strict referrer policy; Sec-Fetch-Site tells the truth there.
    if (origin === "null" && site === "same-origin") return next();
    if (origin !== normalized(c.env.PUBLIC_ORIGIN)) return c.text("Forbidden", 403);
    return next();
  }
  if (site !== undefined && site !== "same-origin" && site !== "none") return c.text("Forbidden", 403);
  return next();
};

/**
 * A strict same-origin test for writes carrying an ambient credential other than the session cookie (the admin
 * page's Basic auth, which the browser re-sends on its own): the `Origin` must be PUBLIC_ORIGIN, or, without one,
 * `Sec-Fetch-Site` must say same-origin. A request that says neither is refused, unlike in `sameOriginOnly`.
 */
export function fromPublicOrigin(origin: string | undefined, site: string | undefined, publicOrigin: string): boolean {
  if (origin !== undefined && origin !== "null") return origin === normalized(publicOrigin);
  return site === "same-origin";
}

let warnedMissingOrigin = false;

/**
 * PUBLIC_ORIGIN decides the same-origin check, the Secure cookie, the Spotify redirect and the station url. Empty
 * (the committed default, so a deploy without it fails loudly) answers plainly and logs once. /healthz stays up.
 */
export const requirePublicOrigin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.PUBLIC_ORIGIN || c.req.path === "/healthz") return next();
  if (!warnedMissingOrigin) {
    warnedMissingOrigin = true;
    console.error("[dococa] PUBLIC_ORIGIN is empty; set it in wrangler.jsonc (or .dev.vars for local dev)");
  }
  return c.text("Server is not configured", 500);
};

/**
 * Only PUBLIC_ORIGIN's host serves the app. Another host (the old workers.dev one) would fail every form post on the
 * origin check and set cookies for the wrong host, so GET/HEAD are sent on to the canonical origin and the rest is refused.
 * The redirect is built from PUBLIC_ORIGIN and the path, never from the incoming host. /healthz answers anywhere.
 */
export const canonicalHost: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  let canonical: string;
  try {
    canonical = new URL(c.env.PUBLIC_ORIGIN).host;
  } catch {
    return next();
  }
  // A request without a Host header (in-process calls, tests) has no host to be wrong about.
  const host = c.req.header("host")?.trim().toLowerCase();
  if (host === undefined || host === canonical || c.req.path === "/healthz") return next();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Forbidden", 403);
  const { pathname, search } = new URL(c.req.url);
  return c.redirect(`${normalized(c.env.PUBLIC_ORIGIN)}${pathname}${search}`, 301);
};
