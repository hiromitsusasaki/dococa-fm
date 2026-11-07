import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { Variables } from "./auth/session";
import { hasUnseenReactions } from "./db/letters";
import type { Env } from "./env";
import type { Listener } from "./types";

type Notice = { listenerId: string; check: () => Promise<boolean> };

/**
 * The header's dot for new reactions. A signed-in `GET` holds the check in its own async context for as long as the
 * request runs; the header runs it only when it draws the `/me` link, so a JSON read or a redirect costs nothing. Two
 * requests of one listener (two tabs) each keep their own. Matched by id, a page that passes a copy of the listener
 * still finds it.
 */
const notices = new AsyncLocalStorage<Notice>();

export const reactionNotice: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const listener = c.get("listener");
  if (c.req.method !== "GET" || !listener?.googleSub) return next();
  let asked: Promise<boolean> | null = null;
  const check = () => (asked ??= hasUnseenReactions(c.env.DB, listener.id).catch(() => false));
  await notices.run({ listenerId: listener.id, check }, next);
};

/** False outside a registered request (not signed in, or not a `GET`), or for another listener. */
export function unseenReactions(listener: Listener): Promise<boolean> {
  const notice = notices.getStore();
  return notice && notice.listenerId === listener.id ? notice.check() : Promise.resolve(false);
}
