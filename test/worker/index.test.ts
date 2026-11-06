import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import * as prepare from "../../src/worker/program/prepare";

afterEach(() => vi.restoreAllMocks());

describe("worker", () => {
  it("GET /healthz returns ok", async () => {
    const res = await SELF.fetch("http://example.com/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /app.css is served from assets", async () => {
    const res = await SELF.fetch("http://example.com/app.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("scheduled hands prepareBatch to waitUntil", async () => {
    const batch = vi.spyOn(prepare, "prepareBatch").mockResolvedValue({ units: 0, audio: 0, failed: 0, remaining: { units: 0, audio: 0 } });
    const waited: Promise<unknown>[] = [];
    await worker.scheduled({ scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry() {} } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => void waited.push(p), passThroughOnException() {} } as ExecutionContext);
    expect(batch).toHaveBeenCalledWith(env, env.DB);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });
});
