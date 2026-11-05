import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../helpers/db";

beforeEach(() => resetDb(env.DB));

const BASE = "http://example.com";

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/dfm_sid=[^;]+/);
  if (!m) throw new Error(`no dfm_sid in: ${raw}`);
  return m[0];
}

function postForm(path: string, cookie: string, body: Record<string, string>) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

async function mcpUrlIn(html: string): Promise<string> {
  const m = html.match(/\/mcp\/[0-9a-f]{48}/);
  if (!m) throw new Error("no mcp url");
  return m[0];
}

describe("session cookie", () => {
  it("issues dfm_sid on the first page request but not on /healthz", async () => {
    const first = await SELF.fetch(`${BASE}/settings`);
    expect(first.status).toBe(200);
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^dfm_sid=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=31536000/);
    expect(setCookie).toMatch(/Path=\//);

    const health = await SELF.fetch(`${BASE}/healthz`);
    expect(health.headers.get("set-cookie")).toBeNull();
  });

  it("starts a new listener in english when Accept-Language leads with english, otherwise in japanese", async () => {
    const en = await SELF.fetch(`${BASE}/settings`, { headers: { "accept-language": "en-US,en;q=0.9,ja;q=0.5" } });
    expect(await en.text()).toContain('<html lang="en">');
    const ja = await SELF.fetch(`${BASE}/settings`, { headers: { "accept-language": "ja,en;q=0.8" } });
    expect(await ja.text()).toContain('<html lang="ja">');
    const { results } = await env.DB.prepare("SELECT lang FROM listeners ORDER BY created_at").all<{ lang: string }>();
    expect(results.map((r) => r.lang).sort()).toEqual(["en", "ja"]);
  });

  it("does not switch an existing listener's language on a later request", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`, { headers: { "accept-language": "ja" } }));
    const res = await SELF.fetch(`${BASE}/settings`, { headers: { cookie, "accept-language": "en-US" } });
    expect(await res.text()).toContain('<html lang="ja">');
  });

  it("reuses the listener when the cookie is sent back", async () => {
    const first = await SELF.fetch(`${BASE}/settings`);
    const cookie = cookieOf(first);
    const second = await SELF.fetch(`${BASE}/settings`, { headers: { cookie } });
    expect(second.headers.get("set-cookie")).toBeNull();
    const { results } = await env.DB.prepare("SELECT id FROM listeners").all();
    expect(results).toHaveLength(1);
  });

  it("gives a tampered cookie a new listener and a new cookie", async () => {
    const first = await SELF.fetch(`${BASE}/settings`);
    const cookie = cookieOf(first);
    const tampered = `${cookie.slice(0, -1)}${cookie.at(-1) === "A" ? "B" : "A"}`;
    const second = await SELF.fetch(`${BASE}/settings`, { headers: { cookie: tampered } });
    const next = cookieOf(second);
    expect(next).not.toBe(cookie);
    expect(next.split(".")[0]).not.toBe(cookie.split(".")[0]);
  });

  it("recreates a listener when the signed id no longer exists", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await resetDb(env.DB);
    const res = await SELF.fetch(`${BASE}/settings`, { headers: { cookie } });
    expect(res.headers.get("set-cookie")).toMatch(/^dfm_sid=/);
  });
});

describe("settings", () => {
  it("shows the anonymous name until a radio name is saved", async () => {
    const res = await SELF.fetch(`${BASE}/settings`);
    expect(await res.text()).toContain("名無しのリスナー");
  });

  it("saves radio name, place and dial, then shows them", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const post = await postForm("/settings", cookie, { radioName: "ヒロ", place: "大船渡", voice: "", dial: "0.8" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/settings?saved=1");

    const html = await (await SELF.fetch(`${BASE}/settings?saved=1`, { headers: { cookie } })).text();
    expect(html).toContain('value="ヒロ"');
    expect(html).toContain('value="大船渡"');
    expect(html).toContain('value="0.8"');
    expect(html).toContain("保存しました");
  });

  it("rejects dial=1.5 with 422 and the error message, saving nothing", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", place: "", voice: "", dial: "1.5" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("入力を確認してください");
    const row = await env.DB.prepare("SELECT radio_name, dial FROM listeners").first<{ radio_name: string; dial: number }>();
    expect(row).toEqual({ radio_name: "", dial: 0.3 });
  });

  it("saves only the dial from the player with 204", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: "ヒロ", place: "大船渡", voice: "v", dial: "0.2" });
    const res = await postForm("/settings/dial", cookie, { dial: "0.9" });
    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT radio_name, voice, dial FROM listeners").first();
    expect(row).toEqual({ radio_name: "ヒロ", voice: "v", dial: 0.9 });
  });

  it("rejects a dial outside 0 to 1 from the player", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    for (const dial of ["1.5", "-0.1", "x"]) expect((await postForm("/settings/dial", cookie, { dial })).status).toBe(422);
    const row = await env.DB.prepare("SELECT dial FROM listeners").first<{ dial: number }>();
    expect(row!.dial).toBe(0.3);
  });

  it("rejects a radio name over 20 characters", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "あ".repeat(21), place: "", voice: "", dial: "0.5" });
    expect(res.status).toBe(422);
  });

  it.each([
    ["radioName", "a@b.co"],
    ["radioName", "090-1234-5678"],
    ["radioName", "example.com"],
    ["place", "https://x.example"],
  ])("rejects a %s that is contact details (%s) with 422", async (field, value) => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", place: "", voice: "", dial: "0.5", [field]: value });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("入力を確認してください");
    const row = await env.DB.prepare("SELECT radio_name, place FROM listeners").first<{ radio_name: string; place: string }>();
    expect(row).toEqual({ radio_name: "", place: "" });
  });

  it("accepts an ordinary radio name and place", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "3人家族", place: "大船渡", voice: "", dial: "0.5" });
    expect(res.status).toBe(303);
  });

  it("escapes user text in the form", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: '<b>"x"</b>', place: "", voice: "", dial: "0.5" });
    const html = await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text();
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("shows the listener id in the MCP section", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const html = await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text();
    expect(html).toContain("リスナー ID");
    expect(html).toContain(cookie.split("=")[1]!.split(".")[0]!);
  });

  it("regenerates the MCP token", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const before = await mcpUrlIn(await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text());
    const post = await postForm("/settings/mcp-token", cookie, {});
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/settings");
    const after = await mcpUrlIn(await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text());
    expect(after).not.toBe(before);
  });
});
