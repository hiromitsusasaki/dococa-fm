import type { Context } from "hono";

/**
 * Lets `promise` finish after the response is sent. `executionCtx` throws outside a real request
 * (tests call `app.request` directly), so there the promise just runs on its own; callers pass
 * work that never rejects.
 */
export function defer(c: Context, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise;
  }
}
