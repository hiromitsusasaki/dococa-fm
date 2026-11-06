import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import app from "../../../src/worker/index";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, listLettersForItem } from "../../../src/worker/db/letters";
import { t } from "../../../src/worker/i18n/t";
import * as prepare from "../../../src/worker/program/prepare";
import { resetDb } from "../../helpers/db";
import { okReply, stubAnthropic } from "../../helpers/anthropic";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, signedInSession, postForm } from "./helpers";

let create: ReturnType<typeof stubAnthropic>;
let prepared: MockInstance<typeof prepare.prepareLetter>;

const verdict = (input: unknown) => ({ content: [{ type: "tool_use", id: "j", name: "judge_letter", input }] });
const translation = (ja: string) => ({ content: [{ type: "tool_use", id: "t", name: "translate", input: { ja } }] });

beforeEach(async () => {
  await resetDb(env.DB);
  (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "sk-test";
  create = stubAnthropic();
  create.mockImplementation(okReply);
  prepared = vi.spyOn(prepare, "prepareLetter").mockResolvedValue({ units: 0, audio: 0, failed: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seedItem() {
  return insertItem(env.DB, itemDraft());
}

describe("POST /letters", () => {
  it("stores a japanese letter verbatim and redirects to the item", async () => {
    const item = await seedItem();
    const cookie = await signedInSession();
    await postForm("/settings", cookie, { radioName: "ヒロ", placeCountry: "JP", placeRegion: "32", voice: "", dial: "0.3" });
    const res = await postForm("/letters", cookie, { itemId: item.id, body: "中学の頃、毎日聴いていた" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/items/${item.id}`);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ kind: "letter", body: "中学の頃、毎日聴いていた", bodyJa: "中学の頃、毎日聴いていた", lang: "ja", radioName: "ヒロ", place: "島根", placeCountry: "JP", placeRegion: "32", status: "public" });
    expect(create).toHaveBeenCalledTimes(2); // moderation, then the english translation; ja is not translated to ja
    expect(l!.bodyEn).toBe("[en] translated");
  });

  it("judges the work's title and creator in the same moderation call", async () => {
    const item = await insertItem(env.DB, itemDraft({ title: "宣伝<タイトル>", creator: "誰かのチャンネル" }));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "いい曲" });
    expect(res.status).toBe(303);
    const req = create.mock.calls[0]![0];
    const user = String(req.messages[0].content);
    expect(user).toContain("<work>");
    expect(user).toContain("題名: 宣伝&lt;タイトル&gt;");
    expect(user).toContain("作者: 誰かのチャンネル");
    expect(user).toContain("<letter>いい曲</letter>");
    expect(req.system).toContain("題名や作者名が中傷・宣伝・個人情報なら");
  });

  it("keeps the original and stores the translation for english", async () => {
    const item = await seedItem();
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(translation("15 歳のときに大好きだった"));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "I loved this at 15" });
    expect(res.status).toBe(303);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ body: "I loved this at 15", bodyJa: "15 歳のときに大好きだった", lang: "en" });
  });

  it("stores the english original as bodyEn and asks for the japanese translation only", async () => {
    const item = await seedItem();
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "I loved this at 15" });
    expect(res.status).toBe(303);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ body: "I loved this at 15", bodyJa: "[ja] translated", bodyEn: "I loved this at 15", lang: "en" });
    expect(create).toHaveBeenCalledTimes(2); // moderation + ja
  });

  it("translates a japanese letter into english for bodyEn", async () => {
    const item = await seedItem();
    await postForm("/letters", await signedInSession(), { itemId: item.id, body: "中学の頃、毎日聴いていた" });
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ bodyJa: "中学の頃、毎日聴いていた", bodyEn: "[en] translated" });
    const req = create.mock.calls[1]![0];
    expect(req.tools[0].input_schema.required).toEqual(["en"]);
    expect(String(req.system)).toContain("English");
  });

  it("translates a letter in a third language into both japanese and english", async () => {
    const item = await seedItem();
    await postForm("/letters", await signedInSession(), { itemId: item.id, body: "Me encantó esta canción, ¡gracias!" });
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ lang: "other", bodyJa: "[ja] translated", bodyEn: "[en] translated" });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("stores the letter with bodyEn null when only the english translation fails", async () => {
    const item = await seedItem();
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockImplementation((req) => (req.tools?.[0]?.input_schema?.required?.[0] === "en" ? Promise.reject(new Error("boom")) : okReply(req)));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "中学の頃、毎日聴いていた" });
    expect(res.status).toBe(303);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ bodyJa: "中学の頃、毎日聴いていた", bodyEn: null, status: "public" });
  });

  it("does not store a translation that carries a url, and does not reject the letter", async () => {
    const item = await seedItem();
    create.mockImplementation((req) => (req.tools?.[0]?.name === "translate" ? { content: [{ type: "tool_use", id: "t", name: "translate", input: { en: "see https://evil.example/x", ja: "https://evil.example/x を見て" } }] } : okReply(req)));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "中学の頃、毎日聴いていた" });
    expect(res.status).toBe(303);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l!.bodyEn).toBeNull();
    const res2 = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "I loved this at 15" });
    expect(res2.status).toBe(303);
    const en = (await listLettersForItem(env.DB, item.id)).find((x) => x.lang === "en")!;
    expect(en.bodyJa).toBe("I loved this at 15"); // the original stands in; bodyJa is NOT NULL
  });

  it("does not store a translation three times longer than the source", async () => {
    const item = await seedItem();
    const long = "あ".repeat(600);
    create.mockImplementation((req) => (req.tools?.[0]?.name === "translate" ? { content: [{ type: "tool_use", id: "t", name: "translate", input: { en: long } }] } : okReply(req)));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "いい曲" });
    expect(res.status).toBe(303);
    expect((await listLettersForItem(env.DB, item.id))[0]!.bodyEn).toBeNull();
  });

  it("letter_body_over_200_chars_rejected", async () => {
    const item = await seedItem();
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "あ".repeat(201) });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(t("letters.tooLong"));
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts exactly 200 code points", async () => {
    const item = await seedItem();
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(translation("笑顔"));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "😀".repeat(200) });
    expect(res.status).toBe(303);
  });

  it("rejects an empty body with 422", async () => {
    const item = await seedItem();
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "  " });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(t("letters.empty"));
  });

  it("POST /letters with unresolvable url → 422", async () => {
    const res = await postForm("/letters", await signedInSession(), { url: "https://example.org/nothing", body: "いい曲" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(t("put.notFound"));
  });

  it("returns 422 with the reason when moderation rejects", async () => {
    const item = await seedItem();
    create.mockResolvedValue(verdict({ ok: false, reason: "ad" }));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "買ってね" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain(t("letters.rejected"));
    expect(html).toContain(t("letters.reason.ad"));
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("returns 429 for the same text within 10 minutes", async () => {
    const item = await seedItem();
    const cookie = await signedInSession();
    expect((await postForm("/letters", cookie, { itemId: item.id, body: "同じ文" })).status).toBe(303);
    const again = await postForm("/letters", cookie, { itemId: item.id, body: "同じ文" });
    expect(again.status).toBe(429);
    expect(await again.text()).toContain(t("letters.duplicate"));
  });

  it("returns 429 with the daily-limit message and asks Claude nothing once today's letters are at LETTER_GLOBAL_DAILY_LIMIT", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id, { body: "先の一通", bodyJa: "先の一通" }));
    const cookie = await signedInSession();
    const capped = env as { LETTER_GLOBAL_DAILY_LIMIT?: string };
    capped.LETTER_GLOBAL_DAILY_LIMIT = "1";
    try {
      const res = await postForm("/letters", cookie, { itemId: item.id, body: "上限の後の一通" });
      expect(res.status).toBe(429);
      expect(await res.text()).toContain(t("letters.dailyLimit"));
      const reply = await postForm("/letters", cookie, { itemId: item.id, body: "わかります", kind: "reply", parentLetterId: parent.id });
      expect(reply.status).toBe(429);
      expect(create).not.toHaveBeenCalled();
      // 私も costs no Claude call and is not capped.
      expect((await postForm("/letters", cookie, { itemId: item.id, kind: "watashimo", parentLetterId: parent.id, body: "x" })).status).toBe(303);
      expect(await listLettersForItem(env.DB, item.id)).toHaveLength(2);
    } finally {
      delete capped.LETTER_GLOBAL_DAILY_LIMIT;
    }
  });

  it("counts only today's letters and replies toward LETTER_GLOBAL_DAILY_LIMIT, not 私も or found voices", async () => {
    const item = await seedItem();
    const old = await insertLetter(env.DB, letterDraft(item.id, { body: "昨日の一通", bodyJa: "昨日の一通" }));
    await env.DB.prepare("UPDATE letters SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(old.id).run();
    await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: old.id, body: "私も", bodyJa: "私も" }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://youtu.be/x", sourceAuthor: "@a", body: "見つけた声", bodyJa: "見つけた声" }));
    const cookie = await signedInSession();
    const capped = env as { LETTER_GLOBAL_DAILY_LIMIT?: string };
    try {
      capped.LETTER_GLOBAL_DAILY_LIMIT = "1";
      expect((await postForm("/letters", cookie, { itemId: item.id, body: "今日の最初の一通" })).status).toBe(303);
      expect((await postForm("/letters", cookie, { itemId: item.id, body: "今日の二通目" })).status).toBe(429);
    } finally {
      delete capped.LETTER_GLOBAL_DAILY_LIMIT;
    }
  });

  it("pauses letters with LETTER_GLOBAL_DAILY_LIMIT=0, and does not count letters from before today's JST midnight", async () => {
    const item = await seedItem();
    const old = await insertLetter(env.DB, letterDraft(item.id, { body: "昨日の一通", bodyJa: "昨日の一通" }));
    await env.DB.prepare("UPDATE letters SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(old.id).run();
    const cookie = await signedInSession();
    const capped = env as { LETTER_GLOBAL_DAILY_LIMIT?: string };
    try {
      capped.LETTER_GLOBAL_DAILY_LIMIT = "0";
      expect((await postForm("/letters", cookie, { itemId: item.id, body: "止まっている日" })).status).toBe(429);
      expect(create).not.toHaveBeenCalled();
      capped.LETTER_GLOBAL_DAILY_LIMIT = "1";
      expect((await postForm("/letters", cookie, { itemId: item.id, body: "今日の一通" })).status).toBe(303);
    } finally {
      delete capped.LETTER_GLOBAL_DAILY_LIMIT;
    }
  });

  it("returns 503 when Claude fails", async () => {
    const item = await seedItem();
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValue(new Error("boom"));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "いい曲" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t("letters.unavailable"));
  });

  it("returns 503 and stores nothing when moderation gives no verdict", async () => {
    const item = await seedItem();
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "いい曲" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t("letters.unavailable"));
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("returns 503 and stores nothing when the translation never comes", async () => {
    const item = await seedItem();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const noTool = { content: [{ type: "text", text: "はい" }] };
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(noTool).mockResolvedValueOnce(noTool);
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "I loved this at 15" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t("letters.unavailable"));
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("returns 422 for an unknown item id", async () => {
    const res = await postForm("/letters", await signedInSession(), { itemId: "nope", body: "いい曲" });
    expect(res.status).toBe(422);
  });

  it("stores a reply under its parent without count side effects", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "わかる", kind: "reply", parentLetterId: parent.id });
    expect(res.status).toBe(303);
    const rows = await env.DB.prepare("SELECT kind, parent_letter_id FROM letters WHERE kind = 'reply'").all();
    expect(rows.results).toEqual([{ kind: "reply", parent_letter_id: parent.id }]);
  });

  it("schedules the unit and audio of a new letter, but not of a watashimo", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const cookie = await signedInSession();
    expect((await postForm("/letters", cookie, { itemId: item.id, body: "中学の頃、毎日聴いていた" })).status).toBe(303);
    const [l] = (await listLettersForItem(env.DB, item.id)).filter((x) => x.body === "中学の頃、毎日聴いていた");
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(prepared.mock.calls[0]![2]).toBe(l!.id);

    expect((await postForm("/letters", cookie, { itemId: item.id, kind: "watashimo", parentLetterId: parent.id, body: "x" })).status).toBe(303);
    expect(prepared).toHaveBeenCalledTimes(1);
  });

  it("does not schedule anything for a letter that is turned down", async () => {
    const item = await seedItem();
    create.mockResolvedValue(verdict({ ok: false, reason: "advert" }));
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, body: "買ってください" });
    expect(res.status).toBe(422);
    expect(prepared).not.toHaveBeenCalled();
  });

  it("watashimo has fixed text, skips Claude, and a second one is 409", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const cookie = await signedInSession();
    const form = { itemId: item.id, kind: "watashimo", parentLetterId: parent.id, body: "ignored" };
    expect((await postForm("/letters", cookie, form)).status).toBe(303);
    expect(create).not.toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT body, body_ja FROM letters WHERE kind = 'watashimo'").first();
    expect(row).toEqual({ body: "私も", body_ja: "私も" });
    expect((await postForm("/letters", cookie, form)).status).toBe(409);
  });

  it("watashimo on two different parents within 10 minutes is 303 both times", async () => {
    const item = await seedItem();
    const a = await insertLetter(env.DB, letterDraft(item.id, { body: "一通目" }));
    const b = await insertLetter(env.DB, letterDraft(item.id, { body: "二通目" }));
    const cookie = await signedInSession();
    for (const p of [a, b]) {
      const res = await postForm("/letters", cookie, { itemId: item.id, kind: "watashimo", parentLetterId: p.id, body: "x" });
      expect(res.status).toBe(303);
    }
    const again = await postForm("/letters", cookie, { itemId: item.id, kind: "watashimo", parentLetterId: a.id, body: "x" });
    expect(again.status).toBe(409);
  });

  it("watashimo without a parent is 422", async () => {
    const item = await seedItem();
    const res = await postForm("/letters", await signedInSession(), { itemId: item.id, kind: "watashimo", body: "x" });
    expect(res.status).toBe(422);
  });
});

describe("POST /letters parent validation", () => {
  const badParent = async (res: Response) => {
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(t("letters.badParent"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM letters WHERE listener_id IS NOT NULL").first())?.n).toBe(0);
  };

  it("rejects a plain letter that names a parent", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    await badParent(await postForm("/letters", await signedInSession(), { itemId: item.id, body: "いい曲", parentLetterId: parent.id }));
  });

  it("rejects a reply to a parent that does not exist", async () => {
    const item = await seedItem();
    await badParent(await postForm("/letters", await signedInSession(), { itemId: item.id, kind: "reply", body: "わかる", parentLetterId: "nope" }));
  });

  it("rejects a reply whose parent belongs to another item", async () => {
    const item = await seedItem();
    const other = await insertItem(env.DB, itemDraft({ title: "Other", externalIds: { itunes: "2" } }));
    const parent = await insertLetter(env.DB, letterDraft(other.id));
    await badParent(await postForm("/letters", await signedInSession(), { itemId: item.id, kind: "reply", body: "わかる", parentLetterId: parent.id }));
  });

  it("rejects a reaction to a parent that is no longer public", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id, { status: "rejected" }));
    await badParent(await postForm("/letters", await signedInSession(), { itemId: item.id, kind: "reply", body: "わかる", parentLetterId: parent.id }));
  });

  it("rejects a reaction to a reaction", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: parent.id }));
    await badParent(await postForm("/letters", await signedInSession(), { itemId: item.id, kind: "watashimo", body: "x", parentLetterId: reply.id }));
  });
});

describe("GET /put", () => {
  it("shows the item card and the form for itemId", async () => {
    const item = await seedItem();
    const html = await (await get(`/put?itemId=${item.id}`, await signedInSession())).text();
    expect(html).toContain("Blue in Green");
    expect(html).toContain('name="body"');
    expect(html).toContain('maxlength="200"');
    expect(html).toContain("/settings");
  });

  it("shows the sender line the same way the item page does", async () => {
    const item = await seedItem();
    const cookie = await signedInSession();
    await postForm("/settings", cookie, { radioName: "ヒロ", placeCountry: "JP", placeRegion: "32", voice: "", dial: "0.3" });
    const who = t("letter.whoPlace", { who: t("letter.who", { name: "ヒロ" }), place: "島根" });
    expect(await (await get(`/put?itemId=${item.id}`, cookie)).text()).toContain(who);
    await postForm("/letters", cookie, { itemId: item.id, body: "いい曲" });
    expect(await (await get(`/items/${item.id}`, cookie)).text()).toContain(who);
  });

  it("says not found for an unresolvable url", async () => {
    const res = await get(`/put?url=${encodeURIComponent("https://example.org/x")}`, await signedInSession());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(t("put.notFound"));
    // Searching by title is on the same page.
    expect(html).toContain(t("put.searchTitle"));
    expect(html).toContain('name="q"');
  });

  it("lays the page out in three panels: choose the work, write the letter, the bookmarklet", async () => {
    const item = await seedItem();
    const html = await (await get(`/put?itemId=${item.id}`, await signedInSession())).text();
    const at = (s: string) => html.indexOf(s);
    expect(html.match(/<section class="panel /g)).toHaveLength(3);
    expect(at(t("put.choose"))).toBeGreaterThan(-1);
    expect(at(t("put.choose"))).toBeLessThan(at(t("put.write")));
    expect(at(t("put.write"))).toBeLessThan(at('name="body"'));
    expect(at('name="body"')).toBeLessThan(at(t("bookmarklet.title")));
    expect(html).not.toContain("/auth/spotify");
  });

  it("offers the three ways to choose a work, in order, before anything is chosen", async () => {
    const cookie = await signedInSession();
    const item = await seedItem();
    const id = decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
    await upsertHistory(env.DB, [{ listenerId: id, itemId: item.id, source: "manual", occurredAt: null, rank: null }]);
    const html = await (await get("/put", cookie)).text();
    const at = (s: string) => html.indexOf(s);
    expect(at(t("put.pasteUrl"))).toBeGreaterThan(-1);
    expect(at(t("put.pasteUrl"))).toBeLessThan(at(t("put.fromFavorites")));
    expect(at(t("put.fromFavorites"))).toBeLessThan(at(t("put.searchTitle")));
    expect(at(t("put.searchTitle"))).toBeLessThan(at(t("bookmarklet.title")));
    expect(html).not.toContain(t("put.write"));
    expect(html.match(/<section class="panel /g)).toHaveLength(2);
    expect(html).not.toContain("/auth/spotify");
  });

  it("puts the draggable bookmarklet button and its three lines on the page", async () => {
    const html = await (await get("/put", await signedInSession())).text();
    expect(html).toMatch(/<a class="button" href="javascript:location.href=[^"]*\/put\?url=[^"]*" draggable="true">/);
    expect(html).toContain(`<h3>${t("bookmarklet.addTitle")}</h3>`);
    for (const key of ["bookmarklet.help1", "bookmarklet.help2", "bookmarklet.help3"] as const) expect(html).toContain(t(key));
  });
});

describe("reactions, report, takedown, bookmarklet", () => {
  it("shows reactions only to the letter's author", async () => {
    const item = await seedItem();
    const cookie = await signedInSession();
    const own = await postForm("/letters", cookie, { itemId: item.id, body: "元の一通" });
    expect(own.status).toBe(303);
    const [parent] = await listLettersForItem(env.DB, item.id);
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", bodyJa: "わかる", body: "わかる", radioName: "返信の人", place: "高知", parentLetterId: parent!.id }));
    const mine = await get(`/letters/${parent!.id}/reactions`, cookie);
    expect(mine.status).toBe(200);
    const html = await mine.text();
    expect(html).toContain("返信の人");
    expect(html).toContain("高知");
    expect(html).toContain("わかる");
    expect((await get(`/letters/${parent!.id}/reactions`, await signedInSession())).status).toBe(404);
  });

  it("puts a report form on every reaction", async () => {
    const item = await seedItem();
    const cookie = await signedInSession();
    await postForm("/letters", cookie, { itemId: item.id, body: "元の一通" });
    const [parent] = await listLettersForItem(env.DB, item.id);
    const r = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: parent!.id }));
    const html = await (await get(`/letters/${parent!.id}/reactions`, cookie)).text();
    expect(html).toContain(`/letters/${r.id}/report`);
  });

  it("shows the original of an english reaction on the reactions page", async () => {
    const item = await seedItem();
    const cookie = await signedInSession();
    await postForm("/letters", cookie, { itemId: item.id, body: "元の一通" });
    const [parent] = await listLettersForItem(env.DB, item.id);
    await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", body: "Me too, truly", bodyJa: "私も、本当に", lang: "en", parentLetterId: parent!.id }));
    const html = await (await get(`/letters/${parent!.id}/reactions`, cookie)).text();
    expect(html).toContain("私も、本当に");
    expect(html).toContain("Me too, truly");
  });

  it("report adds a row and leaves status alone", async () => {
    const item = await seedItem();
    const letter = await insertLetter(env.DB, letterDraft(item.id));
    const res = await postForm(`/letters/${letter.id}/report`, await signedInSession(), { reason: "迷惑" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/items/${item.id}`);
    const rows = await env.DB.prepare("SELECT letter_id, reason FROM reports").all();
    expect(rows.results).toEqual([{ letter_id: letter.id, reason: "迷惑" }]);
    expect((await env.DB.prepare("SELECT status FROM letters").first())?.status).toBe("public");
  });

  it("report on a missing letter is 404", async () => {
    expect((await postForm("/letters/nope/report", await signedInSession(), {})).status).toBe(404);
  });

  it("takedown stores url and reason", async () => {
    const cookie = await signedInSession();
    const res = await postForm("/takedown", cookie, { url: "https://example.org/post", reason: "私の投稿です" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(t("takedown.received"));
    expect((await env.DB.prepare("SELECT url, reason FROM takedowns").all()).results).toEqual([{ url: "https://example.org/post", reason: "私の投稿です" }]);
  });

  it("takedown form can be prefilled from a found letter", async () => {
    const item = await seedItem();
    const l = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://example.org/p", sourceAuthor: "誰か" }));
    const html = await (await get(`/takedown?letterId=${l.id}`, await signedInSession())).text();
    expect(html).toContain("https://example.org/p");
  });

  it("bookmarklet page shows the javascript: one-liner and the three lines on how to use it", async () => {
    const html = await (await get("/bookmarklet", await signedInSession())).text();
    expect(html).toContain("javascript:location.href=");
    expect(html).toContain("/put?url=");
    expect(html).toContain('draggable="true"');
    // Under the page's h1, the block's heading is an h2 (an h3 inside the send page's panel).
    expect(html).toContain(`<h2>${t("bookmarklet.addTitle")}</h2>`);
    const at = (s: string) => html.indexOf(s);
    expect(at(t("bookmarklet.help1"))).toBeGreaterThan(-1);
    expect(at(t("bookmarklet.help1"))).toBeLessThan(at(t("bookmarklet.help2")));
    expect(at(t("bookmarklet.help2"))).toBeLessThan(at(t("bookmarklet.help3")));
  });

  it("bookmarklet builds its origin from a parsed url and refuses a non-http one", async () => {
    const via = async (origin: string) => {
      const res = await app.request("/bookmarklet", {}, { ...env, PUBLIC_ORIGIN: origin });
      return res.text();
    };
    expect(await via("https://dococa.example/some/path?x=1")).toContain("location.href=&#39;https://dococa.example/put?url=&#39;");
    for (const bad of ["javascript:alert(1)", "not a url", "https://x.example';alert(1);'"]) {
      const html = await via(bad);
      expect(html).not.toContain("javascript:location");
      expect(html).toContain("ブックマークレットはいま用意できていません");
    }
  });
});
