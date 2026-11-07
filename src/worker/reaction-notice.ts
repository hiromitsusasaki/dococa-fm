import type { MiddlewareHandler } from "hono";
import type { Variables } from "./auth/session";
import { hasUnseenReactions } from "./db/letters";
import type { Env } from "./env";
import type { Listener } from "./types";

/**
 * The header's dot for new reactions. The session middleware's listener object is the key: a signed-in `GET` registers the
 * check here, and the header runs it only when it draws the `/me` link, so a JSON read or a redirect costs nothing.
 */
const checks = new WeakMap<Listener, () => Promise<boolean>>();

export const reactionNotice: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = (c, next) => {
  const listener = c.get("listener");
  if (c.req.method === "GET" && listener?.googleSub) {
    let asked: Promise<boolean> | null = null;
    checks.set(listener, () => (asked ??= hasUnseenReactions(c.env.DB, listener.id).catch(() => false)));
  }
  return next();
};

/** False for a listener nobody registered (not signed in, not a `GET`, or a copy of the session's object). */
export const unseenReactions = (listener: Listener): Promise<boolean> => checks.get(listener)?.() ?? Promise.resolve(false);
