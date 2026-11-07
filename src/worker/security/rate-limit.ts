import type { Context, MiddlewareHandler } from "hono";
import { type Store, rateLimiter } from "hono-rate-limiter";
import type { Variables } from "../auth/session";
import type { Env } from "../env";
import { tooManyRequests } from "./limited-page";

type AppEnv = { Bindings: Env; Variables: Variables };

export const WINDOW_MS = 60_000;
export const LIMIT_PER_WINDOW = 20;
export const MAX_KEYS = 10_000;
const SWEEP_EVERY_MS = 1_000;

/**
 * Fixed-window counters in this isolate's memory. The library's own MemoryStore starts an interval timer when it is
 * constructed, which a Worker may not do at module scope, so this one has no timers. At `maxKeys` it drops expired
 * keys (at most once a second), and if that is not enough it drops the oldest keys. Counters are per isolate, so the
 * effective limit is a floor-level brake, not an exact quota.
 */
export class WindowStore implements Store<AppEnv> {
  localKeys = true;
  private hits = new Map<string, { totalHits: number; resetTime: Date }>();
  private windowMs = WINDOW_MS;
  private lastSweep = 0;

  constructor(private maxKeys = MAX_KEYS) {}

  get size(): number {
    return this.hits.size;
  }

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  increment(key: string): { totalHits: number; resetTime: Date } {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetTime.getTime() <= now) {
      if (entry) this.hits.delete(key);
      this.makeRoom(now);
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
      this.hits.set(key, entry);
    }
    entry.totalHits += 1;
    return entry;
  }

  private makeRoom(now: number): void {
    if (this.hits.size < this.maxKeys) return;
    if (now - this.lastSweep >= SWEEP_EVERY_MS) {
      this.lastSweep = now;
      for (const [k, v] of this.hits) if (v.resetTime.getTime() <= now) this.hits.delete(k);
    }
    // Map keeps insertion order, so the first keys are the oldest windows.
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k);
    }
  }

  decrement(key: string): void {
    const entry = this.hits.get(key);
    if (entry && entry.totalHits > 0) entry.totalHits -= 1;
  }

  resetKey(key: string): void {
    this.hits.delete(key);
  }
}

/**
 * Routes that write, or that spend a paid or external call. Everything here shares one bucket per IP and one
 * per listener. `GET /tts` and `POST /listens` have their own buckets.
 */
export function isRateLimited(method: string, path: string, query: URLSearchParams): boolean {
  if (method === "GET") return path === "/auth/google" || (path === "/put" && (query.has("itemId") || query.has("url")));
  if (method !== "POST") return false;
  return path === "/letters" || path === "/settings" || path.startsWith("/settings/") || path === "/auth/signout" || path === "/lang" || path === "/episodes" || path === "/start" || path === "/takedown" || path === "/put/register" || /^\/episodes\/[^/]+\/next$/.test(path) || /^\/stations\/[^/]+\/next$/.test(path) || /^\/letters\/[^/]+\/(report|withdraw)$/.test(path);
}

const limitOf = (c: { env: Env }): number => {
  const n = Number.parseInt(c.env.RATE_LIMIT_PER_MINUTE ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : LIMIT_PER_WINDOW;
};

function limiter(keyOf: (c: Context<AppEnv>) => string | null): MiddlewareHandler<AppEnv> {
  return rateLimiter<AppEnv>({
    windowMs: WINDOW_MS,
    limit: limitOf,
    standardHeaders: "draft-6",
    store: new WindowStore(),
    keyGenerator: (c) => keyOf(c) ?? "",
    skip: (c) => keyOf(c) === null || !isRateLimited(c.req.method, c.req.path, new URL(c.req.url).searchParams),
    handler: (c) => tooManyRequests(c),
  });
}

/** Before the session middleware, so a flood does not mint listener rows. */
export const ipRateLimit = limiter((c) => {
  // Cloudflare always sets this header in front of a deployed Worker. Without it (local tests) there is no client to key on.
  const ip = c.req.header("cf-connecting-ip");
  return ip ? `ip:${ip}` : null;
});
/** After the session middleware: one cookie cannot go around the IP bucket by spreading over addresses. */
export const listenerRateLimit = limiter((c) => {
  const listener = c.get("listener");
  return listener ? `listener:${listener.id}` : null;
});

/** `GET /tts` is a paid call on a miss: its own buckets, per listener 60 and per IP 120 a minute (scaled with RATE_LIMIT_PER_MINUTE). */
export const TTS_LISTENER_LIMIT_PER_WINDOW = 60;
export const TTS_IP_LIMIT_PER_WINDOW = 120;

/** A route's own buckets, apart from the shared ones, answering 429 in JSON unless the route renders its own page. */
function routeLimiter(
  perWindow: number,
  keyOf: (c: Context<AppEnv>) => string | null,
  handler: (c: Context<AppEnv>) => Response | Promise<Response> = (c) => c.json({ error: "rate_limited" }, 429),
): MiddlewareHandler<AppEnv> {
  return rateLimiter<AppEnv>({
    windowMs: WINDOW_MS,
    limit: (c) => limitOf(c) * (perWindow / LIMIT_PER_WINDOW),
    standardHeaders: "draft-6",
    store: new WindowStore(),
    keyGenerator: (c) => keyOf(c) ?? "",
    skip: (c) => keyOf(c) === null,
    handler,
  });
}

export const ttsIpRateLimit = routeLimiter(TTS_IP_LIMIT_PER_WINDOW, (c) => {
  const ip = c.req.header("cf-connecting-ip");
  return ip ? `ip:${ip}` : null;
});
/** `GET /letters/:id/audio/:n` spends the same cloud voice as `/tts` on a miss, with no listener: its own bucket, 120 a minute per IP. */
export const letterAudioIpRateLimit = routeLimiter(TTS_IP_LIMIT_PER_WINDOW, (c) => {
  const ip = c.req.header("cf-connecting-ip");
  return ip ? `ip:${ip}` : null;
});
export const ttsListenerRateLimit = routeLimiter(TTS_LISTENER_LIMIT_PER_WINDOW, (c) => {
  const listener = c.get("listener");
  return listener ? `listener:${listener.id}` : null;
});

/**
 * `POST /listens` fires on every letter line a player starts: its own buckets, per listener 120 and per IP 240
 * a minute (scaled with RATE_LIMIT_PER_MINUTE), so listeners on one venue Wi-Fi never use up the IP bucket
 * that `next` and `letters` share.
 */
export const LISTENS_LISTENER_LIMIT_PER_WINDOW = 120;
export const LISTENS_IP_LIMIT_PER_WINDOW = 240;

export const listensIpRateLimit = routeLimiter(LISTENS_IP_LIMIT_PER_WINDOW, (c) => {
  const ip = c.req.header("cf-connecting-ip");
  return ip ? `ip:${ip}` : null;
});
export const listensListenerRateLimit = routeLimiter(LISTENS_LISTENER_LIMIT_PER_WINDOW, (c) => {
  const listener = c.get("listener");
  return listener ? `listener:${listener.id}` : null;
});

/**
 * `GET /put?q=` asks up to four outside search APIs at once: its own bucket, 20 a minute per signed-in listener
 * (scaled with RATE_LIMIT_PER_MINUTE). Anonymous visitors and requests without `q` are not counted (they search nothing).
 * Made once by the route, which renders its own 429 page.
 */
export const SEARCH_LISTENER_LIMIT_PER_WINDOW = 20;

export const searchRateLimit = (onLimited: (c: Context<AppEnv>) => Response | Promise<Response>): MiddlewareHandler<AppEnv> =>
  routeLimiter(
    SEARCH_LISTENER_LIMIT_PER_WINDOW,
    (c) => {
      const listener = c.get("listener");
      return listener && listener.googleSub !== null && c.req.query("q")?.trim() ? `listener:${listener.id}` : null;
    },
    onLimited,
  );
