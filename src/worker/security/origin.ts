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
  if (origin !== undefined) {
    if (origin !== normalized(c.env.PUBLIC_ORIGIN)) return c.text("Forbidden", 403);
    return next();
  }
  const site = c.req.header("sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") return c.text("Forbidden", 403);
  return next();
};
