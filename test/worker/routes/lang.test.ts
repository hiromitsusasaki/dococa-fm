import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getListener, updateListener } from "../../../src/worker/db/listeners";
import { isRateLimited } from "../../../src/worker/security/rate-limit";
import { resetDb } from "../../helpers/db";
import { BASE, newSession } from "./helpers";

beforeEach(() => resetDb(env.DB));

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;

const post = (cookie: string, body: Record<string, string>, headers: Record<string, string> = { origin: env.PUBLIC_ORIGIN }) =>
  SELF.fetch(`${BASE}/lang`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });

describe("POST /lang", () => {
  it("switches the language, goes back to next and touches no other column", async () => {
    const cookie = await newSession();
    const id = idOf(cookie);
    await updateListener(env.DB, id, { lang: "ja", radioName: "ヒロ", placeCountry: "JP", voice: "v", dial: 0.7 });
    const before = await getListener(env.DB, id);
    const res = await post(cookie, { lang: "en", next: "/put" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/put");
    const after = await getListener(env.DB, id);
    expect(after?.lang).toBe("en");
    expect({ ...after, lang: "ja" }).toEqual({ ...before, lang: "ja" });
  });

  it("works for an anonymous listener and for a missing next", async () => {
    const cookie = await newSession();
    const res = await post(cookie, { lang: "en" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect((await getListener(env.DB, idOf(cookie)))?.lang).toBe("en");
  });

  it("refuses an unknown language and changes nothing", async () => {
    const cookie = await newSession();
    await updateListener(env.DB, idOf(cookie), { lang: "ja" });
    const res = await post(cookie, { lang: "fr", next: "/put" });
    expect(res.status).toBe(400);
    expect((await getListener(env.DB, idOf(cookie)))?.lang).toBe("ja");
  });

  it("sends anything but a same-site path to /", async () => {
    const cookie = await newSession();
    for (const next of ["https://evil.example/x", "//evil.example", "put", "/\\evil.example"]) {
      const res = await post(cookie, { lang: "en", next });
      expect(res.status, next).toBe(303);
      expect(res.headers.get("location"), next).toBe("/");
    }
  });

  it("gets the same answer as POST /auth/signout from the Origin guard", async () => {
    const cookie = await newSession();
    const foreign = { origin: "https://evil.example" };
    const lang = await post(cookie, { lang: "en" }, foreign);
    const signout = await SELF.fetch(`${BASE}/auth/signout`, { method: "POST", redirect: "manual", headers: { cookie, ...foreign } });
    expect(lang.status).toBe(signout.status);
    expect(lang.status).toBe(403);
    expect((await getListener(env.DB, idOf(cookie)))?.lang).not.toBe("en");
    const bare = await post(cookie, { lang: "en" }, {});
    const bareSignout = await SELF.fetch(`${BASE}/auth/signout`, { method: "POST", redirect: "manual", headers: { cookie } });
    expect(bare.status).toBe(bareSignout.status);
  });

  it("is rate limited like the other writes", () => {
    expect(isRateLimited("POST", "/lang", new URLSearchParams())).toBe(true);
    expect(isRateLimited("GET", "/lang", new URLSearchParams())).toBe(false);
  });
});
