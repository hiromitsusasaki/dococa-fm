import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import type { Variables } from "./session";

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** A script asking for JSON gets a status it can read; a browser navigation gets sent to sign in. */
function wantsJson(c: AppContext): boolean {
  const mode = c.req.header("sec-fetch-mode");
  if (mode === "cors" || mode === "same-origin") return true;
  const accept = c.req.header("accept") ?? "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

/** The current path with its query, for links that should come back to this page. */
export const currentPath = (c: { req: { path: string; url: string } }): string => c.req.path + new URL(c.req.url).search;

/** The page to come back to: a form post has no page of its own at /letters, so it returns to /put. */
function returnPath(c: AppContext): string {
  if (c.req.method !== "GET" && c.req.path === "/letters") return "/put";
  return currentPath(c);
}

export const requireSignin: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  if (c.get("listener").googleSub !== null) return next();
  if (wantsJson(c)) return c.json({ error: "signin" }, 401);
  return c.redirect(`/auth/google?next=${encodeURIComponent(returnPath(c))}`, 303);
};
