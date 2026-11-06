import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
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

  it("saves radio name, place and dial, then shows them", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const post = await postForm("/settings", cookie, { radioName: "ヒロ", placeCountry: "JP", placeRegion: "32", voice: "", dial: "0.8" });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/settings?saved=1");

    const html = await (await SELF.fetch(`${BASE}/settings?saved=1`, { headers: { cookie } })).text();
    expect(html).toContain('value="ヒロ"');
    expect(html).toMatch(/<option value="JP" selected/);
    expect(html).toMatch(/<option value="32" selected/);
    expect(html).toContain('value="0.8"');
    expect(html).toContain("保存しました");
    const row = await env.DB.prepare("SELECT place, place_country, place_region FROM listeners").first();
    expect(row).toEqual({ place: "島根", place_country: "JP", place_region: "32" });
  });

  it("fills the place from a country alone and from a US state", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: "", placeCountry: "PT", placeRegion: "", voice: "", dial: "0.5" });
    expect(await env.DB.prepare("SELECT place, place_region FROM listeners").first()).toEqual({ place: "ポルトガル", place_region: null });
    await postForm("/settings", cookie, { radioName: "", placeCountry: "US", placeRegion: "CA", voice: "", dial: "0.5" });
    expect((await env.DB.prepare("SELECT place FROM listeners").first<{ place: string }>())!.place).toBe("カリフォルニア州、アメリカ");
  });

  it("clears the place when the country is set back to none", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: "", placeCountry: "JP", placeRegion: "32", voice: "", dial: "0.5" });
    await postForm("/settings", cookie, { radioName: "", placeCountry: "", placeRegion: "", voice: "", dial: "0.5" });
    expect(await env.DB.prepare("SELECT place, place_country, place_region FROM listeners").first()).toEqual({ place: "", place_country: null, place_region: null });
  });

  it("keeps an old free-text place while no country has been chosen", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await env.DB.prepare("UPDATE listeners SET place = '大船渡'").run();
    await postForm("/settings", cookie, { radioName: "ヒロ", placeCountry: "", placeRegion: "", voice: "", dial: "0.5" });
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
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", ...place, voice: "", dial: "0.5" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("入力を確認してください");
    expect(await env.DB.prepare("SELECT radio_name, place_country FROM listeners").first()).toEqual({ radio_name: "", place_country: null });
  });

  it("rejects dial=1.5 with 422 and the error message, saving nothing", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", voice: "", dial: "1.5" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("入力を確認してください");
    const row = await env.DB.prepare("SELECT radio_name, dial FROM listeners").first<{ radio_name: string; dial: number }>();
    expect(row).toEqual({ radio_name: "", dial: 0.3 });
  });

  it("saves only the dial from the player with 204", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: "ヒロ", placeCountry: "", placeRegion: "", voice: "v", dial: "0.2" });
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
    const res = await postForm("/settings", cookie, { radioName: "あ".repeat(21), voice: "", dial: "0.5" });
    expect(res.status).toBe(422);
  });

  it.each([
    ["radioName", "a@b.co"],
    ["radioName", "090-1234-5678"],
    ["radioName", "example.com"],
  ])("rejects a %s that is contact details (%s) with 422", async (field, value) => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "ヒロ", voice: "", dial: "0.5", [field]: value });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("入力を確認してください");
    const row = await env.DB.prepare("SELECT radio_name, place FROM listeners").first<{ radio_name: string; place: string }>();
    expect(row).toEqual({ radio_name: "", place: "" });
  });

  it("accepts an ordinary radio name", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    const res = await postForm("/settings", cookie, { radioName: "3人家族", voice: "", dial: "0.5" });
    expect(res.status).toBe(303);
  });

  it("escapes user text in the form", async () => {
    const cookie = cookieOf(await SELF.fetch(`${BASE}/settings`));
    await postForm("/settings", cookie, { radioName: '<b>"x"</b>', voice: "", dial: "0.5" });
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

describe("public station settings", () => {
  const rowOf = async (name: string) => env.DB.prepare("SELECT station_public AS pub, station_slug AS slug FROM listeners WHERE display_name = ?").bind(name).first<{ pub: number; slug: string | null }>();

  it("shows the station section only to a signed-in listener", async () => {
    const anon = await (await get("/settings", await newAnon())).text();
    expect(anon).not.toContain('name="stationPublic"');
    const html = await (await get("/settings", await signedInSession())).text();
    expect(html).toContain('name="stationPublic"');
    expect(html).toContain('name="stationSlug"');
  });

  it("saves a chosen slug (trimmed, lower-cased) and makes the station public", async () => {
    const cookie = await signedInSession("Hiro");
    const res = await postForm("/settings", cookie, { radioName: "", voice: "", dial: "0.5", stationPublic: "1", stationSlug: "  My-Radio " });
    expect(res.status).toBe(303);
    expect(await rowOf("Hiro")).toEqual({ pub: 1, slug: "my-radio" });
    const html = await (await get("/settings", cookie)).text();
    expect(html).toContain('href="http://127.0.0.1:5173/stations/s:my-radio"');
  });

  it("generates radio-xxxx when public is turned on without a slug, never from the google name", async () => {
    const cookie = await signedInSession("Hiro Sasaki");
    await postForm("/settings", cookie, { radioName: "ちくわ", voice: "", dial: "0.5", stationPublic: "1" });
    const row = await rowOf("Hiro Sasaki");
    expect(row?.pub).toBe(1);
    expect(row?.slug).toMatch(/^radio-[a-z0-9]{4}$/);
  });

  it("explains that only the radio name appears on the public page", async () => {
    expect(await (await get("/settings", await signedInSession())).text()).toContain("公開ページにはラジオネームだけが出ます");
  });

  it("keeps the slug when public is turned off, so the URL stays stable", async () => {
    const cookie = await signedInSession("Hiro");
    await postForm("/settings", cookie, { radioName: "", voice: "", dial: "0.5", stationPublic: "1", stationSlug: "my-radio" });
    await postForm("/settings", cookie, { radioName: "", voice: "", dial: "0.5" });
    expect(await rowOf("Hiro")).toEqual({ pub: 0, slug: "my-radio" });
  });

  it("422s with the taken message when another listener has the chosen slug", async () => {
    await postForm("/settings", await signedInSession("Hiro"), { radioName: "", voice: "", dial: "0.5", stationPublic: "1", stationSlug: "my-radio" });
    const res = await postForm("/settings", await signedInSession("Other"), { radioName: "", voice: "", dial: "0.5", stationPublic: "1", stationSlug: "my-radio" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("その URL は使われています");
    expect(await rowOf("Other")).toEqual({ pub: 0, slug: null });
  });

  it("422s for a slug that is too short or has bad characters", async () => {
    const cookie = await signedInSession("Hiro");
    for (const bad of ["ab", "has space", "UPPER_x"]) {
      expect((await postForm("/settings", cookie, { radioName: "", voice: "", dial: "0.5", stationSlug: bad })).status).toBe(422);
    }
  });

  it("ignores the station fields for an anonymous listener but still saves the rest", async () => {
    const cookie = await newAnon();
    const res = await postForm("/settings", cookie, { radioName: "Tama", voice: "", dial: "0.5", stationPublic: "1", stationSlug: "sneaky" });
    expect(res.status).toBe(303);
    const row = await env.DB.prepare("SELECT radio_name AS n, station_public AS pub, station_slug AS slug FROM listeners WHERE radio_name = 'Tama'").first();
    expect(row).toEqual({ n: "Tama", pub: 0, slug: null });
  });
});

async function newAnon(): Promise<string> {
  return cookieOf(await SELF.fetch(`${BASE}/settings`));
}
