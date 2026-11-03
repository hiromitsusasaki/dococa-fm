import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
});
