import { afterEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "../../../src/worker/auth/crypto";
import { exchangeGoogleCode, googleAuthorizeUrl, parseIdToken } from "../../../src/worker/auth/google";
import type { Env } from "../../../src/worker/env";

const env = { PUBLIC_ORIGIN: "http://127.0.0.1:5173", GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "sec" } as Env;
const NOW = 1_800_000_000_000;
const enc = new TextEncoder();

/** Unsigned on purpose: parseIdToken does not check the signature. */
export function idToken(payload: Record<string, unknown>): string {
  const part = (o: unknown) => toBase64Url(enc.encode(JSON.stringify(o)));
  return `${part({ alg: "RS256" })}.${part(payload)}.sig`;
}
const good = { iss: "https://accounts.google.com", aud: "cid", exp: NOW / 1000 + 60, nonce: "n1", sub: "g-1", name: "Aiko", email: "aiko@example.com" };

afterEach(() => vi.unstubAllGlobals());

describe("googleAuthorizeUrl", () => {
  it("asks for openid email profile and returns to the callback", () => {
    const url = new URL(googleAuthorizeUrl(env, "st", "no"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5173/auth/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("nonce")).toBe("no");
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("parseIdToken", () => {
  it("returns sub, name and email for a valid token", () => {
    expect(parseIdToken(idToken(good), env, "n1", () => NOW)).toEqual({ sub: "g-1", name: "Aiko", email: "aiko@example.com" });
  });
  it("accepts the bare accounts.google.com issuer", () => {
    expect(parseIdToken(idToken({ ...good, iss: "accounts.google.com" }), env, "n1", () => NOW)).not.toBeNull();
  });
  it.each([
    ["aud", { aud: "other" }],
    ["iss", { iss: "https://evil.example" }],
    ["exp", { exp: NOW / 1000 - 1 }],
    ["nonce", { nonce: "zzz" }],
    ["sub", { sub: undefined }],
  ])("rejects a wrong %s", (_n, patch) => {
    expect(parseIdToken(idToken({ ...good, ...patch }), env, "n1", () => NOW)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parseIdToken("not-a-jwt", env, "n1", () => NOW)).toBeNull();
    expect(parseIdToken("a.!!!.c", env, "n1", () => NOW)).toBeNull();
  });
  it("falls back to empty name and email", () => {
    expect(parseIdToken(idToken({ ...good, name: undefined, email: undefined }), env, "n1", () => NOW)).toEqual({ sub: "g-1", name: "", email: "" });
  });
});

describe("exchangeGoogleCode", () => {
  it("posts the code with grant_type=authorization_code and returns the id token", async () => {
    const fn = vi.fn(async (_u: string, init?: RequestInit) => new Response(JSON.stringify({ id_token: "tok" }), { status: 200 }));
    expect(await exchangeGoogleCode(env, "the-code", fn as unknown as typeof fetch)).toEqual({ idToken: "tok" });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("client_secret")).toBe("sec");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:5173/auth/google/callback");
  });
  it("returns null on a 500, without logging the body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn(async () => new Response("secret-body", { status: 500 }));
    expect(await exchangeGoogleCode(env, "c", fn as unknown as typeof fetch)).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-body");
    warn.mockRestore();
  });
  it("returns null when the response has no id_token or fetch throws", async () => {
    expect(await exchangeGoogleCode(env, "c", (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await exchangeGoogleCode(env, "c", (async () => { throw new Error("net"); }) as unknown as typeof fetch)).toBeNull();
  });
});
