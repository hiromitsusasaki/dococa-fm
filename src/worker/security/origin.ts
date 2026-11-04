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
 * `/admin/*` is Bearer-only and `/mcp/*` token-only, so neither is subject to this.
 */
export const sameOriginOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = c.req.path;
  if (!UNSAFE.has(c.req.method) || path === "/admin" || path.startsWith("/admin/") || path === "/mcp" || path.startsWith("/mcp/")) return next();
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

let warnedMissingOrigin = false;

/**
 * PUBLIC_ORIGIN decides the same-origin check, the Secure cookie, the Spotify redirect and the MCP url. Empty
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
