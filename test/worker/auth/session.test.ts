import { describe, expect, it } from "vitest";
import { isSessionExempt, signSession, verifySession } from "../../../src/worker/auth/session";

const SECRET = "unit-test-secret";

describe("signSession / verifySession", () => {
  it("round-trips a listener id", async () => {
    const cookie = await signSession("listener-1", SECRET);
    expect(cookie.startsWith("listener-1.")).toBe(true);
    expect(await verifySession(cookie, SECRET)).toBe("listener-1");
  });

  it("returns null for a tampered signature or id", async () => {
    const cookie = await signSession("listener-1", SECRET);
    const last = cookie.at(-1) === "A" ? "B" : "A";
    expect(await verifySession(`${cookie.slice(0, -1)}${last}`, SECRET)).toBeNull();
    expect(await verifySession(cookie.replace("listener-1", "listener-2"), SECRET)).toBeNull();
  });

  it("returns null under a different secret", async () => {
    const cookie = await signSession("listener-1", SECRET);
    expect(await verifySession(cookie, "other-secret")).toBeNull();
  });

  it("returns null for malformed cookies", async () => {
    for (const bad of ["", "nodot", ".", "id.", ".sig", "a.b.c"]) {
      expect(await verifySession(bad, SECRET)).toBeNull();
    }
    expect(await verifySession(undefined, SECRET)).toBeNull();
  });
});

describe("isSessionExempt", () => {
  it("exempts health, admin and static assets", () => {
    for (const p of ["/healthz", "/admin/episodes", "/app.css", "/assets/player.js", "/src/client/player.tsx", "/favicon.ico", "/manifest.webmanifest", "/icon.svg", "/bed-3.mp3", "/kv.jpg", "/kv-mobile.jpg", "/about/radio.jpg"]) {
      expect(isSessionExempt(p), p).toBe(true);
    }
  });

  it("covers everything else, including look-alike prefixes", () => {
    for (const p of ["/", "/settings", "/apix", "/api/search", "/administrator", "/mcp/abc", "/healthz2", "/about", "/about/", "/kv.jpgx", "/x/kv.jpg", "/about/a/b.jpg", "/about/x.png"]) {
      expect(isSessionExempt(p), p).toBe(false);
    }
  });
});
