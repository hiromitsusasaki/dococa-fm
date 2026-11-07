import type { MiddlewareHandler } from "hono";
import type { Variables } from "./auth/session";
import { hasUnseenReactions } from "./db/letters";
import type { Env } from "./env";
import type { Listener } from "./types";

type Check = () => Promise<boolean>;

/**
 * The header's dot for new reactions. A signed-in `GET` registers the check under the listener's id for as long as the
 * request runs; the header runs it only when it draws the `/me` link, so a JSON read or a redirect costs nothing. Keyed by
 * id, a page that passes a copy of the listener still finds it.
 */
const checks = new Map<string, Check>();

export const reactionNotice: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const listener = c.get("listener");
  if (c.req.method !== "GET" || !listener?.googleSub) return next();
  let asked: Promise<boolean> | null = null;
  const check: Check = () => (asked ??= hasUnseenReactions(c.env.DB, listener.id).catch(() => false));
  checks.set(listener.id, check);
  try {
    await next();
  } finally {
    // Two tabs of one listener may overlap: leave the other request's check in place.
    if (checks.get(listener.id) === check) checks.delete(listener.id);
  }
};

/** False for a listener nobody registered (not signed in, or not a `GET`). */
export const unseenReactions = (listener: Listener): Promise<boolean> => checks.get(listener.id)?.() ?? Promise.resolve(false);
