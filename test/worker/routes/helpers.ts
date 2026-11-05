import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { updateListener } from "../../../src/worker/db/listeners";

export const BASE = "http://example.com";

export async function newSession(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/settings`);
  const m = (res.headers.get("set-cookie") ?? "").match(/dfm_sid=[^;]+/);
  if (!m) throw new Error("no dfm_sid");
  return m[0];
}

export function postForm(path: string, cookie: string, body: Record<string, string>) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

export const get = (path: string, cookie: string) => SELF.fetch(`${BASE}${path}`, { headers: { cookie } });

/** A session whose listener is bound to a Google account, as after sign-in. */
export async function signedInSession(displayName = "Hiro"): Promise<string> {
  const cookie = await newSession();
  const id = cookie.split("=")[1]!.split(".")[0]!;
  await updateListener(env.DB, id, { googleSub: `g-${crypto.randomUUID()}`, displayName });
  return cookie;
}
