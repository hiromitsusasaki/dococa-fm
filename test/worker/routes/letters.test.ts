import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, listLettersForItem } from "../../../src/worker/db/letters";
import { t } from "../../../src/worker/i18n/t";
import { resetDb } from "../../helpers/db";
import { stubAnthropic } from "../../helpers/anthropic";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, newSession, postForm } from "./helpers";

let create: ReturnType<typeof stubAnthropic>;

const verdict = (input: unknown) => ({ content: [{ type: "tool_use", id: "j", name: "judge_letter", input }] });
const translation = (ja: string) => ({ content: [{ type: "tool_use", id: "t", name: "translate", input: { ja } }] });

beforeEach(async () => {
  await resetDb(env.DB);
  (env as { ANTHROPIC_API_KEY: string }).ANTHROPIC_API_KEY = "sk-test";
  create = stubAnthropic();
  create.mockResolvedValue(verdict({ ok: true }));
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
    const cookie = await newSession();
    await postForm("/settings", cookie, { radioName: "ヒロ", place: "大船渡", voice: "", dial: "0.3" });
    const res = await postForm("/letters", cookie, { itemId: item.id, body: "中学の頃、毎日聴いていた" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/items/${item.id}`);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ kind: "letter", body: "中学の頃、毎日聴いていた", bodyJa: "中学の頃、毎日聴いていた", lang: "ja", radioName: "ヒロ", place: "大船渡", status: "public" });
    expect(create).toHaveBeenCalledTimes(1); // moderation only; ja is not translated
  });

  it("keeps the original and stores the translation for english", async () => {
    const item = await seedItem();
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(translation("15 歳のときに大好きだった"));
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "I loved this at 15" });
    expect(res.status).toBe(303);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ body: "I loved this at 15", bodyJa: "15 歳のときに大好きだった", lang: "en" });
  });

  it("letter_body_over_200_chars_rejected", async () => {
    const item = await seedItem();
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "あ".repeat(201) });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(t("letters.tooLong"));
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts exactly 200 code points", async () => {
    const item = await seedItem();
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(translation("笑顔"));
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "😀".repeat(200) });
    expect(res.status).toBe(303);
  });

  it("rejects an empty body with 422", async () => {
    const item = await seedItem();
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "  " });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(t("letters.empty"));
  });

  it("POST /letters with unresolvable url → 422", async () => {
    const res = await postForm("/letters", await newSession(), { url: "https://example.org/nothing", body: "いい曲" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(t("put.notFound"));
  });

  it("returns 422 with the reason when moderation rejects", async () => {
    const item = await seedItem();
    create.mockResolvedValue(verdict({ ok: false, reason: "ad" }));
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "買ってね" });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain(t("letters.rejected"));
    expect(html).toContain(t("letters.reason.ad"));
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("returns 429 for the same text within 10 minutes", async () => {
    const item = await seedItem();
    const cookie = await newSession();
    expect((await postForm("/letters", cookie, { itemId: item.id, body: "同じ文" })).status).toBe(303);
    const again = await postForm("/letters", cookie, { itemId: item.id, body: "同じ文" });
    expect(again.status).toBe(429);
    expect(await again.text()).toContain(t("letters.duplicate"));
  });

  it("returns 503 when Claude fails", async () => {
    const item = await seedItem();
    vi.spyOn(console, "error").mockImplementation(() => {});
    create.mockRejectedValue(new Error("boom"));
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "いい曲" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t("letters.unavailable"));
  });

  it("returns 503 and stores nothing when the translation never comes", async () => {
    const item = await seedItem();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const noTool = { content: [{ type: "text", text: "はい" }] };
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(noTool).mockResolvedValueOnce(noTool);
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "I loved this at 15" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain(t("letters.unavailable"));
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("returns 422 for an unknown item id", async () => {
    const res = await postForm("/letters", await newSession(), { itemId: "nope", body: "いい曲" });
    expect(res.status).toBe(422);
  });

  it("stores a reply under its parent without count side effects", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const res = await postForm("/letters", await newSession(), { itemId: item.id, body: "わかる", kind: "reply", parentLetterId: parent.id });
    expect(res.status).toBe(303);
    const rows = await env.DB.prepare("SELECT kind, parent_letter_id FROM letters WHERE kind = 'reply'").all();
    expect(rows.results).toEqual([{ kind: "reply", parent_letter_id: parent.id }]);
  });

  it("watashimo has fixed text, skips Claude, and a second one is 409", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const cookie = await newSession();
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
    const cookie = await newSession();
    for (const p of [a, b]) {
      const res = await postForm("/letters", cookie, { itemId: item.id, kind: "watashimo", parentLetterId: p.id, body: "x" });
      expect(res.status).toBe(303);
    }
    const again = await postForm("/letters", cookie, { itemId: item.id, kind: "watashimo", parentLetterId: a.id, body: "x" });
    expect(again.status).toBe(409);
  });

  it("watashimo without a parent is 422", async () => {
    const item = await seedItem();
    const res = await postForm("/letters", await newSession(), { itemId: item.id, kind: "watashimo", body: "x" });
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
    await badParent(await postForm("/letters", await newSession(), { itemId: item.id, body: "いい曲", parentLetterId: parent.id }));
  });

  it("rejects a reply to a parent that does not exist", async () => {
    const item = await seedItem();
    await badParent(await postForm("/letters", await newSession(), { itemId: item.id, kind: "reply", body: "わかる", parentLetterId: "nope" }));
  });

  it("rejects a reply whose parent belongs to another item", async () => {
    const item = await seedItem();
    const other = await insertItem(env.DB, itemDraft({ title: "Other", externalIds: { itunes: "2" } }));
    const parent = await insertLetter(env.DB, letterDraft(other.id));
    await badParent(await postForm("/letters", await newSession(), { itemId: item.id, kind: "reply", body: "わかる", parentLetterId: parent.id }));
  });

  it("rejects a reaction to a reaction", async () => {
    const item = await seedItem();
    const parent = await insertLetter(env.DB, letterDraft(item.id));
    const reply = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: parent.id }));
    await badParent(await postForm("/letters", await newSession(), { itemId: item.id, kind: "watashimo", body: "x", parentLetterId: reply.id }));
  });
});

describe("GET /put", () => {
  it("shows the item card and the form for itemId", async () => {
    const item = await seedItem();
    const html = await (await get(`/put?itemId=${item.id}`, await newSession())).text();
    expect(html).toContain("Blue in Green");
    expect(html).toContain('name="body"');
    expect(html).toContain('maxlength="200"');
    expect(html).toContain("/settings");
  });

  it("shows the sender line the same way the item page does", async () => {
    const item = await seedItem();
    const cookie = await newSession();
    await postForm("/settings", cookie, { radioName: "ヒロ", place: "大船渡", voice: "", dial: "0.3" });
    const who = t("letter.whoPlace", { who: t("letter.who", { name: "ヒロ" }), place: "大船渡" });
    expect(await (await get(`/put?itemId=${item.id}`, cookie)).text()).toContain(who);
    await postForm("/letters", cookie, { itemId: item.id, body: "いい曲" });
    expect(await (await get(`/items/${item.id}`, cookie)).text()).toContain(who);
  });

  it("says not found for an unresolvable url", async () => {
    const res = await get(`/put?url=${encodeURIComponent("https://example.org/x")}`, await newSession());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(t("put.notFound"));
  });
});

describe("reactions, report, takedown, bookmarklet", () => {
  it("shows reactions only to the letter's author", async () => {
    const item = await seedItem();
    const cookie = await newSession();
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
    expect((await get(`/letters/${parent!.id}/reactions`, await newSession())).status).toBe(404);
  });

  it("puts a report form on every reaction", async () => {
    const item = await seedItem();
    const cookie = await newSession();
    await postForm("/letters", cookie, { itemId: item.id, body: "元の一通" });
    const [parent] = await listLettersForItem(env.DB, item.id);
    const r = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", parentLetterId: parent!.id }));
    const html = await (await get(`/letters/${parent!.id}/reactions`, cookie)).text();
    expect(html).toContain(`/letters/${r.id}/report`);
  });

  it("shows the original of an english reaction on the reactions page", async () => {
    const item = await seedItem();
    const cookie = await newSession();
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
    const res = await postForm(`/letters/${letter.id}/report`, await newSession(), { reason: "迷惑" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/items/${item.id}`);
    const rows = await env.DB.prepare("SELECT letter_id, reason FROM reports").all();
    expect(rows.results).toEqual([{ letter_id: letter.id, reason: "迷惑" }]);
    expect((await env.DB.prepare("SELECT status FROM letters").first())?.status).toBe("public");
  });

  it("report on a missing letter is 404", async () => {
    expect((await postForm("/letters/nope/report", await newSession(), {})).status).toBe(404);
  });

  it("takedown stores url and reason", async () => {
    const cookie = await newSession();
    const res = await postForm("/takedown", cookie, { url: "https://example.org/post", reason: "私の投稿です" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(t("takedown.received"));
    expect((await env.DB.prepare("SELECT url, reason FROM takedowns").all()).results).toEqual([{ url: "https://example.org/post", reason: "私の投稿です" }]);
  });

  it("takedown form can be prefilled from a found letter", async () => {
    const item = await seedItem();
    const l = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", sourceUrl: "https://example.org/p", sourceAuthor: "誰か" }));
    const html = await (await get(`/takedown?letterId=${l.id}`, await newSession())).text();
    expect(html).toContain("https://example.org/p");
  });

  it("bookmarklet page shows the javascript: one-liner", async () => {
    const html = await (await get("/bookmarklet", await newSession())).text();
    expect(html).toContain("javascript:location.href=");
    expect(html).toContain("/put?url=");
  });
});
