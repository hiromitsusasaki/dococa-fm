import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { getUnits, listUnits, setUnitLiked, upsertUnit } from "../../../src/worker/db/units";
import * as prepare from "../../../src/worker/program/prepare";
import { UNIT_CLAIM_TTL_MS } from "../../../src/worker/program/unit";
import { claimTts } from "../../../src/worker/tts/claim";
import { resetDb } from "../../helpers/db";
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

  it("answers 404 for a unit that does not exist and 422 for a bad language or value", async () => {
    const letter = await seed();
    expect((await postForm(`/admin/units/missing/ja/like`, { liked: "1" })).status).toBe(404);
    expect((await postForm(`/admin/units/${letter.id}/xx/like`, { liked: "1" })).status).toBe(422);
    expect((await postForm(`/admin/units/${letter.id}/ja/like`, { liked: "yes" })).status).toBe(422);
  });
});

describe("POST /admin/units/:letterId/:lang/remake", () => {
  it("deletes the unit, makes it again in the request and answers 303 back", async () => {
    const letter = await seed();
    const res = await postForm(`/admin/units/${letter.id}/ja/remake`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/units?lang=ja");
    expect((await getUnits(env.DB, [letter.id], "ja")).size).toBe(0);
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

  it("answers 404 for a letter that does not exist", async () => {
    expect((await postForm(`/admin/units/missing/ja/remake`)).status).toBe(404);
  });
});
