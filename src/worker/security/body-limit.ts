import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env } from "../env";

/** A letter is 200 characters; forms and MCP calls are far below this. */
export const PUBLIC_BODY_MAX = 64 * 1024;
/** `/admin/found` takes a batch of found voices. */
export const ADMIN_BODY_MAX = 1024 * 1024;

const tooLarge = (c: Context) => c.text("Payload too large", 413);
const publicLimit = bodyLimit({ maxSize: PUBLIC_BODY_MAX, onError: tooLarge });
const adminLimit = bodyLimit({ maxSize: ADMIN_BODY_MAX, onError: tooLarge });

const isAdmin = (path: string) => path === "/admin" || path.startsWith("/admin/");

/** Caps a request body before anything reads it, with or without Content-Length (the stream is counted). */
export const limitBodies: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  return (isAdmin(c.req.path) ? adminLimit : publicLimit)(c, next);
};
