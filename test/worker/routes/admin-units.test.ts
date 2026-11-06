import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { getUnits, listUnits, setUnitLiked, upsertUnit } from "../../../src/worker/db/units";
import * as prepare from "../../../src/worker/program/prepare";
import { UNIT_CLAIM_TTL_MS } from "../../../src/worker/program/unit";
import { claimTts } from "../../../src/worker/tts/claim";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { stubFetch } from "../../helpers/fetch";
import { itemDraft, letterDraft } from "../db/helpers";

const TOKEN = "admin-token-test";
const e = { ...env, ADMIN_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-test" };
const ORIGIN = "http://127.0.0.1:5173";
const basic = (token = TOKEN) => `Basic ${btoa(`admin:${token}`)}`;

const getPage = (path: string, authorization?: string, withEnv: object = e) => app.request(path, { headers: authorization ? { authorization } : {} }, withEnv);
const postForm = (path: string, form: Record<string, string> = {}, headers: Record<string, string> = { authorization: basic(), origin: ORIGIN }, withEnv: object = e) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() }, withEnv);

async function seed(body = "夜中に一人で聴いていました。") {
  const item = await insertItem(env.DB, itemDraft({ title: "Blue in Green" }));
  const letter = await insertLetter(env.DB, letterDraft(item.id, { body }));
  await upsertUnit(env.DB, { letterId: letter.id, lang: "ja", intro: "静かな一曲です。", after: "いいお便りでした。", verified: true, audioReady: true });
  return letter;
}

let prepareLetter: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await resetDb(env.DB);
  prepareLetter = vi.spyOn(prepare, "prepareLetter").mockResolvedValue({ units: 1, audio: 0, failed: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin units auth", () => {
  it("opens the page with Basic auth and with Bearer", async () => {
    await seed();
    const viaBasic = await getPage("/admin/units", basic());
    expect(viaBasic.status).toBe(200);
    expect(viaBasic.headers.get("content-type")).toContain("text/html");
    expect(viaBasic.headers.get("cache-control")).toBe("no-store");
    expect((await getPage("/admin/units", `Bearer ${TOKEN}`)).status).toBe(200);
    expect((await getPage("/admin/units.json", basic())).status).toBe(200);
  });

  it("answers 401 for a wrong or missing token, with a Basic challenge only on the page", async () => {
    const missing = await getPage("/admin/units");
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Basic realm="dococa admin"');
    expect((await getPage("/admin/units", basic("nope"))).status).toBe(401);
    expect((await getPage("/admin/units", `Basic ${btoa("someone:" + TOKEN)}`)).status).toBe(401);
    expect((await getPage("/admin/units", "Bearer nope")).status).toBe(401);
    const json = await getPage("/admin/units.json");
    expect(json.status).toBe(401);
    expect(json.headers.get("www-authenticate")).toBeNull();
    expect((await postForm("/admin/units/x/ja/like", { liked: "1" }, { origin: ORIGIN })).status).toBe(401);
    expect((await getPage("/admin/units", basic(""), { ...e, ADMIN_TOKEN: "" })).status).toBe(401);
  });

  it("refuses a Basic-authenticated write that is not from the same origin (the browser sends Basic on its own)", async () => {
    const letter = await seed();
    expect((await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "1" }, { authorization: basic(), origin: "https://evil.example" })).status).toBe(403);
    expect((await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "1" }, { authorization: basic(), "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "1" }, { authorization: basic() })).status).toBe(403);
    expect((await listUnits(env.DB, { lang: "ja", limit: 10 }))[0]!.liked).toBe(false);
    // Bearer is never sent by a browser on its own, so scripts need no origin.
    expect((await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "1" }, { authorization: `Bearer ${TOKEN}` })).status).toBe(303);
    expect((await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "0" }, { authorization: basic(), "sec-fetch-site": "same-origin" })).status).toBe(303);
  });
});

describe("GET /admin/units", () => {
  it("shows the work, the letter's first 80 code points, intro, after, verified, liked and the two forms, without the public nav", async () => {
    const letter = await seed("あ".repeat(79) + "😀" + "ぬ".repeat(10));
    await setUnitLiked(env.DB, letter.id, "ja", true);
    const html = await (await getPage("/admin/units?lang=ja", basic())).text();
    for (const s of ["Blue in Green", "静かな一曲です。", "いいお便りでした。", `action="/admin/units/${letter.id}/ja/like"`, `action="/admin/units/${letter.id}/ja/remake"`]) expect(html).toContain(s);
    expect(html).toContain("あ".repeat(79) + "😀" + "…");
    expect(html).not.toContain("ぬ");
    expect(html).toContain('name="liked" value="0"');
    expect(html).not.toContain('class="nav');
  });

  it("hides the like button on an unverified unit, escapes the texts, and leaves out units of letters no longer public", async () => {
    const item = await insertItem(env.DB, itemDraft({ title: "<b>x</b>" }));
    const unverified = await insertLetter(env.DB, letterDraft(item.id));
    await upsertUnit(env.DB, { letterId: unverified.id, lang: "ja", intro: "<b>紹介</b>", after: "感想", verified: false, audioReady: false });
    const rejected = await insertLetter(env.DB, letterDraft(item.id, { status: "rejected" }));
    await upsertUnit(env.DB, { letterId: rejected.id, lang: "ja", intro: "非公開の紹介", after: "感想", verified: true, audioReady: false });
    const html = await (await getPage("/admin/units?lang=ja", basic())).text();
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("&lt;b&gt;紹介&lt;/b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain(`/admin/units/${unverified.id}/ja/like`);
    expect(html).toContain(`/admin/units/${unverified.id}/ja/remake`);
    expect(html).toContain("検証済み");
    expect(html).not.toContain("非公開の紹介");
    const json = (await (await getPage("/admin/units.json?lang=ja", `Bearer ${TOKEN}`)).json()) as { units: { letterId: string }[] };
    expect(json.units.map((u) => u.letterId)).toEqual([unverified.id]);
  });

  it("serves the same rows as JSON for the script, with the cursor", async () => {
    const letter = await seed();
    const res = await getPage("/admin/units.json?lang=ja&limit=10", `Bearer ${TOKEN}`);
    const body = (await res.json()) as { units: Record<string, unknown>[]; next: string | null };
    expect(body.units).toEqual([
      expect.objectContaining({ letterId: letter.id, lang: "ja", title: "Blue in Green", letterBody: "夜中に一人で聴いていました。", intro: "静かな一曲です。", after: "いいお便りでした。", verified: true, liked: false }),
    ]);
    expect(body.next).toBeNull();
    expect((await getPage("/admin/units.json?lang=xx", `Bearer ${TOKEN}`)).status).toBe(422);
  });
});

describe("POST /admin/units/:letterId/:lang/like", () => {
  it("sets liked from the form and answers 303 back to the list", async () => {
    const letter = await seed();
    const res = await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/units?lang=ja");
    expect((await listUnits(env.DB, { lang: "ja", limit: 10 }))[0]!.liked).toBe(true);
    await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "0" });
    expect((await listUnits(env.DB, { lang: "ja", limit: 10 }))[0]!.liked).toBe(false);
  });

  it("keeps the page's place: the forms carry after and limit, and the 303 goes back to that page", async () => {
    const first = await seed();
    const second = await seed();
    const [a, b] = [first.id, second.id].sort();
    const html = await (await getPage(`/admin/units?lang=ja&limit=1&after=${a}`, basic())).text();
    expect(html).toContain(`action="/admin/units/${b}/ja/like"`);
    expect(html).toContain(`<input type="hidden" name="after" value="${a}"/>`);
    expect(html).toContain('<input type="hidden" name="limit" value="1"/>');
    const res = await postForm(`/admin/units/${b}/ja/like`, { liked: "1", after: a!, limit: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/units?lang=ja&limit=1&after=${encodeURIComponent(a!)}`);
    stubAnthropic().mockResolvedValue(toolUse("write_unit", { intro: "雨の夜に似合う一曲です。", after: "素敵なお便りでした。" }));
    const remade = await postForm(`/admin/units/${b}/ja/remake`, { after: a!, limit: "1" });
    expect(remade.status).toBe(303);
    expect(remade.headers.get("location")).toBe(`/admin/units?lang=ja&limit=1&after=${encodeURIComponent(a!)}`);
    expect((await postForm(`/admin/units/${b}/ja/like`, { liked: "1", limit: "0" })).status).toBe(422);
  });

  it("answers 404 for a unit that does not exist and 422 for a bad language or value", async () => {
    const letter = await seed();
    expect((await postForm(`/admin/units/missing/ja/like`, { liked: "1" })).status).toBe(404);
    expect((await postForm(`/admin/units/${letter.id}/xx/like`, { liked: "1" })).status).toBe(422);
    expect((await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "yes" })).status).toBe(422);
  });
});

describe("POST /admin/units/:letterId/:lang/remake", () => {
  const NEW = { intro: "雨の夜に似合う一曲です。", after: "素敵なお便りでした。" };
  const unitOf = async (id: string) => (await getUnits(env.DB, [id], "ja")).get(id);
  /** The unit `seed` stores, as the page shows it. */
  const OLD = { intro: "静かな一曲です。", after: "いいお便りでした。", verified: true, audioReady: true };

  it("replaces the unit with a new verified one in the request, voices it, and answers 303 back", async () => {
    const letter = await seed();
    stubAnthropic().mockResolvedValue(toolUse("write_unit", NEW));
    const res = await postForm(`/admin/units/${letter.id}/ja/remake`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/units?lang=ja");
    expect(await unitOf(letter.id)).toMatchObject({ ...NEW, verified: true, audioReady: false });
    expect(prepareLetter).toHaveBeenCalledTimes(1);
    expect(prepareLetter.mock.calls[0]!.slice(2)).toEqual([letter.id, "ja"]);
  });

  it("answers 409 while another run holds the unit's claim, and keeps the unit", async () => {
    const letter = await seed();
    await claimTts(env.DB, `unit:${letter.id}:ja`, Date.now(), UNIT_CLAIM_TTL_MS);
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`)).status).toBe(409);
    expect((await getUnits(env.DB, [letter.id], "ja")).size).toBe(1);
    expect(prepareLetter).not.toHaveBeenCalled();
  });

  it("keeps the unit when no new one could be made: no Claude key (503) or the daily cap (429)", async () => {
    const letter = await seed();
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`, {}, undefined, { ...e, ANTHROPIC_API_KEY: "" })).status).toBe(503);
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`, {}, undefined, { ...e, UNIT_DAILY_LIMIT: "0" })).status).toBe(429);
    expect((await getUnits(env.DB, [letter.id], "ja")).size).toBe(1);
    expect(prepareLetter).not.toHaveBeenCalled();
  });

  it("keeps the old unit and answers 503 when Claude answers 5xx", async () => {
    const letter = await seed();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch([["https://api.anthropic.com/v1/messages", () => new Response("{}", { status: 500, headers: { "retry-after-ms": "0" } })]]);
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`)).status).toBe(503);
    expect(await unitOf(letter.id)).toMatchObject(OLD);
    expect(prepareLetter).not.toHaveBeenCalled();
  });

  it("keeps the old unit and answers 503 when the new lines fail verification", async () => {
    const letter = await seed();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAnthropic().mockResolvedValue(toolUse("write_unit", { intro: "夜中に一人で聴いていました。", after: "夜中に一人で聴いていました。" }));
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`)).status).toBe(503);
    expect(await unitOf(letter.id)).toMatchObject(OLD);
  });

  it("keeps the old unit and answers 503 when the new one cannot be stored", async () => {
    const letter = await seed();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAnthropic().mockResolvedValue(toolUse("write_unit", NEW));
    // Every statement still works except the replacing write (the second batch, after the claim), which fails as D1 would.
    let batches = 0;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (++batches === 2) throw new Error("D1_ERROR: replace failed");
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`, {}, undefined, { ...e, DB: db })).status).toBe(503);
    expect(await unitOf(letter.id)).toMatchObject(OLD);
    expect(prepareLetter).not.toHaveBeenCalled();
  });

  it("counts the remade unit toward UNIT_DAILY_LIMIT, so remakes stop at the cap", async () => {
    const letter = await seed();
    stubAnthropic().mockResolvedValue(toolUse("write_unit", NEW));
    const capped = { ...e, UNIT_DAILY_LIMIT: "2" };
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`, {}, undefined, capped)).status).toBe(303);
    expect((await postForm(`/admin/units/${letter.id}/ja/remake`, {}, undefined, capped)).status).toBe(429);
    expect(prepareLetter).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a letter that does not exist", async () => {
    expect((await postForm(`/admin/units/missing/ja/remake`)).status).toBe(404);
  });
});
