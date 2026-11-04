import type { Context, MiddlewareHandler } from "hono";
import { type Store, rateLimiter } from "hono-rate-limiter";
import type { Variables } from "../auth/session";
import type { Env } from "../env";
import { tooManyRequests } from "./limited-page";

type AppEnv = { Bindings: Env; Variables: Variables };

export const WINDOW_MS = 60_000;
export const LIMIT_PER_WINDOW = 20;
/** A valid MCP token is a known caller; hosted connectors share egress IPs and make several requests per session. */
export const MCP_TOKEN_LIMIT_PER_WINDOW = 60;
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

/** Routes that write, or that spend a paid or external call. Everything here shares one bucket per IP and one per listener. `/mcp/*` has its own rule. */
export function isRateLimited(method: string, path: string, query: URLSearchParams): boolean {
  if (path === "/api" || path.startsWith("/api/")) return true;
  if (method === "GET") return path === "/put" && (query.has("itemId") || query.has("url"));
  if (method !== "POST") return false;
  return path === "/letters" || path === "/episodes" || path === "/start" || path === "/takedown" || /^\/episodes\/[^/]+\/next$/.test(path) || /^\/letters\/[^/]+\/report$/.test(path);
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

const mcpTokenStore = new WindowStore();
const mcpIpStore = new WindowStore();

/**
 * `/mcp/<token>`: a valid token counts against that token (60 a minute); an unknown token counts against the caller's IP
 * (20 a minute), which is what bounds guessing. Returns true when the request must be refused with 429.
 */
export function mcpRateLimited(env: Env, ip: string | undefined, token: string, valid: boolean): boolean {
  const base = limitOf({ env });
  if (valid) return mcpTokenStore.increment(`token:${token}`).totalHits > base * (MCP_TOKEN_LIMIT_PER_WINDOW / LIMIT_PER_WINDOW);
  if (!ip) return false;
  return mcpIpStore.increment(`ip:${ip}`).totalHits > base;
}
