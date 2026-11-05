import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessToken, parseServiceAccount, resetTokenCache } from "../../../src/worker/tts/google-auth";
import { makeServiceAccount } from "../../helpers/service-account";

const { sa, json, publicKey } = await makeServiceAccount();
const fromB64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const decode = (s: string) => JSON.parse(new TextDecoder().decode(fromB64url(s)));

const tokenResponse = (token: string, expiresIn = 3600) => new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }));

beforeEach(() => resetTokenCache());

describe("parseServiceAccount", () => {
  it("reads the three fields", () => {
    expect(parseServiceAccount(json)).toEqual(sa);
  });

  it.each([
    ["not json", "{nope"],
    ["null", "null"],
    ["no client_email", JSON.stringify({ private_key: "k", project_id: "p" })],
    ["empty private_key", JSON.stringify({ client_email: "e", private_key: "", project_id: "p" })],
    ["non-string project_id", JSON.stringify({ client_email: "e", private_key: "k", project_id: 1 })],
  ])("rejects %s with a fixed message", (_name, input) => {
    expect(() => parseServiceAccount(input)).toThrow(new Error("tts sa json invalid"));
  });
});

describe("accessToken", () => {
  it("posts a signed RS256 jwt-bearer assertion and returns the token", async () => {
    const fetchFn = vi.fn(async () => tokenResponse("tok-1"));
    const token = await accessToken(sa, fetchFn as unknown as typeof fetch, () => 1_700_000_000_000);
    expect(token).toBe("tok-1");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");

    const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
    expect(decode(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(c);
    expect(claims).toMatchObject({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: "https://oauth2.googleapis.com/token", iat: 1_700_000_000 });
    expect(claims.exp - claims.iat).toBe(3600);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });

  it("reuses the token until a minute before it expires, then fetches again", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => tokenResponse(`tok-${++n}`, 3600));
    const f = fetchFn as unknown as typeof fetch;
    const t0 = 1_700_000_000_000;
    expect(await accessToken(sa, f, () => t0)).toBe("tok-1");
    expect(await accessToken(sa, f, () => t0 + 3_539_000)).toBe("tok-1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await accessToken(sa, f, () => t0 + 3_540_000)).toBe("tok-2");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws the status only when the token endpoint refuses", async () => {
    const fetchFn = vi.fn(async () => new Response("invalid_grant secret detail", { status: 401 }));
    await expect(accessToken(sa, fetchFn as unknown as typeof fetch)).rejects.toThrow(new Error("tts token 401"));
  });
});
