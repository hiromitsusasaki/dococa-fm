import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as listeners from "../../../src/worker/db/listeners";
import { resetDb } from "../../helpers/db";
import { get, signedInSession } from "./helpers";

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

  it("asks for where you live, not for a land", async () => {
    const html = await (await SELF.fetch(`${BASE}/settings`, { headers: { "accept-language": "ja" } })).text();
    expect(html).toContain("お住まい");
    expect(html).not.toContain("土地");
  });

  it("has no language select, and ignores a posted lang", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`, { headers: { "accept-language": "ja" } }));
    const html = await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text();
    expect(html).not.toMatch(/<select[^>]*name="lang"/);
    const post = await postForm("/settings", cookie, { radioName: "ヒロ", lang: "en" });
    expect(post.status).toBe(303);
    const row = await env.DB.prepare("SELECT lang FROM listeners").first<{ lang: string }>();
    expect(row?.lang).toBe("ja");
  });

  it("saves radio name and place, then shows them", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const post = await postForm("/settings", cookie, { radioName: "ヒロ", placeCountry: "JP", placeRegion: "32", dial: "0.8" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/settings?saved=1");

    const html = await (await SELF.fetch(`${BASE}/settings?saved=1`, { headers: { cookie } })).text();
    expect(html).toContain('value="ヒロ"');
    expect(html).toMatch(/<option value="JP" selected/);
    expect(html).toMatch(/<option value="32" selected/);
    expect(html).toContain("保存しました");
    const row = await env.DB.prepare("SELECT place, place_country, place_region FROM listeners").first();
    expect(row).toEqual({ place: "島根", place_country: "JP", place_region: "32" });
  });

  it("fills the place from a country alone and from a US state", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: "", placeCountry: "PT", placeRegion: "", dial: "0.5" });
    expect(await env.DB.prepare("SELECT place, place_region FROM listeners").first()).toEqual({ place: "ポルトガル", place_region: null });
    await postForm("/settings", cookie, { radioName: "", placeCountry: "US", placeRegion: "CA", dial: "0.5" });
    expect((await env.DB.prepare("SELECT place FROM listeners").first<{ place: string }>())!.place).toBe("カリフォルニア州、アメリカ");
  });

  it("clears the place when the country is set back to none", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: "", placeCountry: "JP", placeRegion: "32", dial: "0.5" });
    await postForm("/settings", cookie, { radioName: "", placeCountry: "", placeRegion: "", dial: "0.5" });
    expect(await env.DB.prepare("SELECT place, place_country, place_region FROM listeners").first()).toEqual({ place: "", place_country: null, place_region: null });
  });

  it("keeps an old free-text place while no country has been chosen", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await env.DB.prepare("UPDATE listeners SET place = '大船渡'").run();
    await postForm("/settings", cookie, { radioName: "ヒロ", placeCountry: "", placeRegion: "", dial: "0.5" });
    expect((await env.DB.prepare("SELECT place FROM listeners").first<{ place: string }>())!.place).toBe("大船渡");
  });

  it.each([
    ["a region of another country", { placeCountry: "JP", placeRegion: "CA" }],
    ["a region that is not listed", { placeCountry: "JP", placeRegion: "99" }],
    ["a region without a country", { placeCountry: "", placeRegion: "13" }],
    ["a region for a country with no list", { placeCountry: "PT", placeRegion: "13" }],
    ["an unknown country", { placeCountry: "ZZ", placeRegion: "" }],
  ])("rejects %s with 422 and saves nothing", async (_name, place) => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", ...place, dial: "0.5" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("入力を確認してください");
    expect(await env.DB.prepare("SELECT radio_name, place_country FROM listeners").first()).toEqual({ radio_name: "", place_country: null });
  });

  it("has no dial: the screen shows none, a dial in the form is not saved, and the player's old route is gone", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const html = await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text();
    expect(html).not.toContain('name="dial"');
    expect(html).not.toContain("セレンディピティ");
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", dial: "0.9" });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare("SELECT radio_name, dial FROM listeners").first<{ radio_name: string; dial: number }>();
    expect(row).toEqual({ radio_name: "ヒロ", dial: 0.3 });
    expect((await postForm("/settings/dial", cookie, { dial: "0.9" })).status).toBe(404);
  });

  it("rejects a radio name over 20 characters", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "あ".repeat(21), dial: "0.5" });
    expect(res.status).toBe(422);
  });

  it.each([
    ["radioName", "a@b.co"],
    ["radioName", "090-1234-5678"],
    ["radioName", "example.com"],
  ])("rejects a %s that is contact details (%s) with 422", async (field, value) => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", dial: "0.5", [field]: value });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("入力を確認してください");
    const row = await env.DB.prepare("SELECT radio_name, place FROM listeners").first<{ radio_name: string; place: string }>();
    expect(row).toEqual({ radio_name: "", place: "" });
  });

  it("accepts an ordinary radio name", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "3人家族", dial: "0.5" });
    expect(res.status).toBe(303);
  });

  it("escapes user text in the form", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: '<b>"x"</b>', dial: "0.5" });
    const html = await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text();
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });

  it("shows the listener id at the end of the page, and no MCP url", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const html = await (await SELF.fetch(`${BASE}/settings`, { headers: { cookie } })).text();
    expect(html).not.toContain("/mcp/");
    expect(html).toContain("リスナー ID");
    expect(html).toContain(cookie.split("=")[1]!.split(".")[0]!);
  });
});

describe("the public radio is not set here any more", () => {
  const rowOf = async (name: string) => env.DB.prepare("SELECT station_public AS pub, station_slug AS slug FROM listeners WHERE display_name = ?").bind(name).first<{ pub: number; slug: string | null }>();

  it("has no station fields, and points a signed-in listener to the my page instead", async () => {
    const html = await (await get("/settings", await signedInSession())).text();
    expect(html).not.toContain('name="stationPublic"');
    expect(html).not.toContain('name="stationSlug"');
    expect(html).toMatch(/<a href="\/me#radio">公開ラジオの設定はマイページで<\/a>/);
    const anon = await (await get("/settings", await newAnon())).text();
    expect(anon).not.toContain("公開ラジオの設定はマイページで");
  });

  it("keeps a public radio public and its slug when the profile is saved, and ignores posted station fields", async () => {
    const cookie = await signedInSession("Hiro");
    const id = cookie.split("=")[1]!.split(".")[0]!;
    await listeners.updateListener(env.DB, id, { stationPublic: true, stationSlug: "hiro-fm" });
    expect((await postForm("/settings", cookie, { radioName: "ちくわ" })).status).toBe(303);
    expect(await rowOf("Hiro")).toEqual({ pub: 1, slug: "hiro-fm" });
    await listeners.updateListener(env.DB, id, { stationPublic: false });
    expect((await postForm("/settings", cookie, { radioName: "ちくわ", stationPublic: "1", stationSlug: "sneaky" })).status).toBe(303);
    expect(await rowOf("Hiro")).toEqual({ pub: 0, slug: "hiro-fm" });
  });

  it("has no DJ voice field and ignores a posted voice", async () => {
    const cookie = await signedInSession("Hiro");
    expect(await (await get("/settings", cookie)).text()).not.toContain('name="voice"');
    const before = await env.DB.prepare("SELECT voice FROM listeners WHERE display_name = 'Hiro'").first<{ voice: string }>();
    const res = await postForm("/settings", cookie, { radioName: "", voice: "somebody-else", dial: "0.5" });
    expect(res.status).toBe(303);
    expect(await env.DB.prepare("SELECT voice FROM listeners WHERE display_name = 'Hiro'").first()).toEqual(before);
  });
});

async function newAnon(): Promise<string> {
  return cookieOf(await SELF.fetch(`${BASE}/settings`));
}
