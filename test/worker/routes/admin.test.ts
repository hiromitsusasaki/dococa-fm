import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import { createListener, getListener } from "../../../src/worker/db/listeners";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter, listLettersForItem } from "../../../src/worker/db/letters";
import { t } from "../../../src/worker/i18n/t";
import { stubAnthropic } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { json, stubFetch } from "../../helpers/fetch";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, newSession } from "./helpers";

const TOKEN = "admin-token-test";
const e = { ...env, ADMIN_TOKEN: TOKEN };

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, withEnv: object = e) =>
  app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) }, withEnv);

const voice = (over: Record<string, unknown> = {}) => ({ body: "十五の夏に、この曲だけ聴いていました。", author: "ゆうき", url: "https://www.youtube.com/watch?v=abc&lc=c1", ...over });

beforeEach(() => resetDb(env.DB));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin auth", () => {
  it("answers 401 without a token", async () => {
    const res = await call("POST", "/admin/found", { itemId: "x", voices: [] }, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("answers 401 for a wrong token and for a non-bearer scheme", async () => {
    expect((await call("POST", "/admin/found", {}, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await call("POST", "/admin/found", {}, { authorization: TOKEN })).status).toBe(401);
  });

  it("answers 401 for every admin route when ADMIN_TOKEN is empty, even with an empty bearer", async () => {
    const empty = { ...env, ADMIN_TOKEN: "" };
    for (const [m, p] of [["POST", "/admin/found"], ["POST", "/admin/items"], ["GET", "/admin/items/x"], ["POST", "/admin/episodes"], ["POST", "/admin/letters/x/reject"]]) {
      expect((await call(m!, p!, {}, { authorization: "Bearer " }, empty)).status).toBe(401);
      expect((await call(m!, p!, {}, { authorization: "Bearer" }, empty)).status).toBe(401);
    }
  });
});

describe("POST /admin/found", () => {
  const post = (body: unknown) => call("POST", "/admin/found", body);

  it("rejects 101 code points with 422 naming the voice, and stores nothing", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const res = await post({ itemId: item.id, voices: [voice(), voice({ body: "あ".repeat(101), url: "https://example.com/2" })] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ index: 1 });
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("counts emoji as one code point", async () => {
    const item = await insertItem(env.DB, itemDraft());
    expect((await post({ itemId: item.id, voices: [voice({ body: "😀".repeat(100) })] })).status).toBe(200);
  });

  it("rejects a missing url, a missing author and an unsafe url with 422", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const { url: _u, ...noUrl } = voice();
    const { author: _a, ...noAuthor } = voice();
    expect((await post({ itemId: item.id, voices: [noUrl] })).status).toBe(422);
    expect((await post({ itemId: item.id, voices: [noAuthor] })).status).toBe(422);
    expect((await post({ itemId: item.id, voices: [voice({ author: "" })] })).status).toBe(422);
    expect((await post({ itemId: item.id, voices: [voice({ url: "javascript:alert(1)" })] })).status).toBe(422);
    expect((await post({ itemId: item.id, voices: [voice({ url: "http://127.0.0.1/x" })] })).status).toBe(422);
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("answers 404 for an unknown item", async () => {
    expect((await post({ itemId: "nope", voices: [voice()] })).status).toBe(404);
  });

  it("stores a found voice verbatim and shows it in its own section with source and link", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const v = voice({ body: "  原文のまま、<b>そのまま</b>  " });
    const res = await post({ itemId: item.id, voices: [v] });
    expect(res.status).toBe(200);
    const { letterIds } = (await res.json()) as { letterIds: string[] };
    expect(letterIds).toHaveLength(1);
    const [stored] = await listLettersForItem(env.DB, item.id);
    expect(stored).toMatchObject({ id: letterIds[0], kind: "found", body: v.body, bodyJa: v.body, lang: "ja", radioName: "ゆうき", sourceAuthor: "ゆうき", sourceUrl: v.url, listenerId: null, parentLetterId: null, status: "public", place: "" });

    const html = await (await get(`/items/${item.id}`, await newSession())).text();
    const foundSection = html.slice(html.indexOf(t("item.foundVoices")));
    expect(foundSection).toContain("ゆうき");
    expect(foundSection).toContain("https://www.youtube.com/watch?v=abc&amp;lc=c1");
    expect(html.slice(0, html.indexOf(t("item.foundVoices")))).not.toContain("ゆうき");
  });

  it("skips a url already stored for the item and a repeat inside the same request", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const first = (await (await post({ itemId: item.id, voices: [voice()] })).json()) as { letterIds: string[] };
    const res = await post({ itemId: item.id, voices: [voice(), voice({ url: "https://example.com/n" }), voice({ url: "https://example.com/n" })] });
    const body = (await res.json()) as { letterIds: string[]; skipped: string[] };
    expect(body.letterIds).toHaveLength(1);
    expect(body.skipped).toEqual([first.letterIds[0]]);
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(2);
  });

  const keyed = { ...e, ANTHROPIC_API_KEY: "sk-test" };
  const judge = (input: unknown) => ({ content: [{ type: "tool_use", id: "j", name: "judge_letter", input }] });
  const translated = (ja: string) => ({ content: [{ type: "tool_use", id: "t", name: "translate", input: { ja } }] });
  /** Answers by the tool the request offers: judgement, then translation. */
  const stubClaude = (verdict: (body: string) => unknown, translation: unknown = translated("十五歳の夏を思い出す")) => {
    const create = stubAnthropic();
    create.mockImplementation((req: any) => (req.tools[0].name === "judge_letter" ? verdict(String(req.messages[0].content)) : translation));
    return create;
  };

  it("translates a non-japanese voice and keeps the original", async () => {
    const create = stubClaude(() => judge({ ok: true }));
    const item = await insertItem(env.DB, itemDraft());
    const res = await call("POST", "/admin/found", { itemId: item.id, voices: [voice({ body: "Reminds me of being fifteen", author: "sam" })] }, undefined, keyed);
    expect(res.status).toBe(200);
    const [stored] = await listLettersForItem(env.DB, item.id);
    expect(stored).toMatchObject({ lang: "en", body: "Reminds me of being fifteen", bodyJa: "十五歳の夏を思い出す" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("answers 503 and stores nothing when the translation never comes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubClaude(() => judge({ ok: true }), { content: [] });
    const item = await insertItem(env.DB, itemDraft());
    const res = await call("POST", "/admin/found", { itemId: item.id, voices: [voice({ body: "Reminds me of being fifteen" })] }, undefined, keyed);
    expect(res.status).toBe(503);
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("leaves out a voice that moderation turns down, stores the others untouched and reports it", async () => {
    stubClaude((prompt) => (prompt.includes("宣伝です") ? judge({ ok: false, reason: "ad" }) : judge({ ok: true })));
    const item = await insertItem(env.DB, itemDraft());
    const good = voice({ body: "  そのまま <b>残る</b>  " });
    const bad = voice({ body: "宣伝です", url: "https://example.com/ad" });
    const res = await call("POST", "/admin/found", { itemId: item.id, voices: [bad, good] }, undefined, keyed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { letterIds: string[]; rejected: unknown[] };
    expect(body.letterIds).toHaveLength(1);
    expect(body.rejected).toEqual([{ index: 0, url: "https://example.com/ad", reason: "ad" }]);
    const stored = await listLettersForItem(env.DB, item.id);
    expect(stored.map((l) => l.body)).toEqual([good.body]);
  });

  it("answers 503 and stores nothing when moderation gives no verdict", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubClaude(() => ({ content: [] }));
    const item = await insertItem(env.DB, itemDraft());
    const res = await call("POST", "/admin/found", { itemId: item.id, voices: [voice(), voice({ url: "https://example.com/2" })] }, undefined, keyed);
    expect(res.status).toBe(503);
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("does not collect a rejected voice again", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const first = (await (await post({ itemId: item.id, voices: [voice()] })).json()) as { letterIds: string[] };
    expect((await call("POST", `/admin/letters/${first.letterIds[0]}/reject`)).status).toBe(200);
    const again = (await (await post({ itemId: item.id, voices: [voice()] })).json()) as { letterIds: string[]; skipped: string[] };
    expect(again.letterIds).toEqual([]);
    expect(again.skipped).toEqual([first.letterIds[0]]);
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });
});

describe("admin items", () => {
  const OEMBED = "https://www.youtube.com/oembed";

  it("creates an item from a url and returns it", async () => {
    stubFetch([
      [OEMBED, () => json({ title: "Some Song", author_name: "Some Channel", thumbnail_url: "https://i.ytimg.com/x.jpg" })],
      ["https://itunes.apple.com", () => json({ resultCount: 0, results: [] })],
    ]);
    const res = await call("POST", "/admin/items", { url: "https://www.youtube.com/watch?v=abcdefghijk" });
    expect(res.status).toBe(200);
    const { item } = (await res.json()) as { item: { id: string; title: string } };
    expect(item.title).toBe("Some Song");
    const got = await call("GET", `/admin/items/${item.id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ item: { id: item.id, title: "Some Song" } });
  });

  it("answers 422 for an unresolvable url and 404 for an unknown id", async () => {
    stubFetch([]);
    expect((await call("POST", "/admin/items", { url: "https://example.com/nothing" })).status).toBe(422);
    expect((await call("POST", "/admin/items", { url: "not a url" })).status).toBe(422);
    expect((await call("POST", "/admin/items", { url: "http://127.0.0.1/x" })).status).toBe(422);
    expect((await call("GET", "/admin/items/nope")).status).toBe(404);
  });
});

describe("POST /admin/episodes", () => {
  it("makes a demo episode for the given listener", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = await createListener(env.DB);
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id));
    const res = await call("POST", "/admin/episodes", { listenerId: listener.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; cloudTts: boolean };
    expect(body.id).toBeTruthy();
    expect(body.cloudTts).toBe(false);
    const row = await env.DB.prepare("SELECT listener_id FROM episodes WHERE id = ?").bind(body.id).first<{ listener_id: string }>();
    expect(row?.listener_id).toBe(listener.id);
  });

  it("marks the episode for the cloud voice when a tts key is set", async () => {
    const listener = await createListener(env.DB);
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id));
    const res = await call("POST", "/admin/episodes", { listenerId: listener.id }, undefined, { ...e, GOOGLE_TTS_API_KEY: "k" });
    expect(await res.json()).toMatchObject({ cloudTts: true });
  });

  it("answers 404 for an unknown listener and 422 without one", async () => {
    expect((await call("POST", "/admin/episodes", { listenerId: "nope" })).status).toBe(404);
    expect((await call("POST", "/admin/episodes", {})).status).toBe(422);
  });
});

describe("POST /admin/letters/:id/reject", () => {
  it("flips the status and the letter leaves the item page", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const letter = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", body: "消す声", bodyJa: "消す声", sourceUrl: "https://example.com/x", sourceAuthor: "a" }));
    const cookie = await newSession();
    expect(await (await get(`/items/${item.id}`, cookie)).text()).toContain("消す声");
    const res = await call("POST", `/admin/letters/${letter.id}/reject`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await (await get(`/items/${item.id}`, cookie)).text()).not.toContain("消す声");
  });

  it("answers 404 for a missing letter", async () => {
    expect((await call("POST", "/admin/letters/nope/reject")).status).toBe(404);
  });
});

describe("POST /admin/listeners", () => {
  it("creates a demo listener with the given radio name and place", async () => {
    const res = await call("POST", "/admin/listeners", { radioName: "Marisol", place: "Oaxaca, México", demo: true });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(await getListener(env.DB, id)).toMatchObject({ radioName: "Marisol", place: "Oaxaca, México", demo: true });
  });

  it("refuses a listener that is not marked as demo, a blank name and a contact-like place", async () => {
    expect((await call("POST", "/admin/listeners", { radioName: "A", place: "x", demo: false })).status).toBe(422);
    expect((await call("POST", "/admin/listeners", { radioName: " ", place: "x", demo: true })).status).toBe(422);
    expect((await call("POST", "/admin/listeners", { radioName: "A", place: "a@b.co", demo: true })).status).toBe(422);
  });

  it("keeps to the settings screen's limits (20 and 30)", async () => {
    expect((await call("POST", "/admin/listeners", { radioName: "a".repeat(21), place: "x", demo: true })).status).toBe(422);
    expect((await call("POST", "/admin/listeners", { radioName: "a".repeat(20), place: "x".repeat(31), demo: true })).status).toBe(422);
    expect((await call("POST", "/admin/listeners", { radioName: "a".repeat(20), place: "x".repeat(30), demo: true })).status).toBe(200);
  });

  it("is behind the admin token", async () => {
    expect((await call("POST", "/admin/listeners", { radioName: "A", place: "x", demo: true }, {})).status).toBe(401);
  });
});

describe("POST /admin/letters", () => {
  const verdict = (input: unknown) => ({ content: [{ type: "tool_use", id: "j", name: "judge_letter", input }] });
  const translation = (ja: string) => ({ content: [{ type: "tool_use", id: "t", name: "translate", input: { ja } }] });
  const withKey = { ...e, ANTHROPIC_API_KEY: "sk-test" };

  async function demoListener() {
    const res = await call("POST", "/admin/listeners", { radioName: "Marisol", place: "Oaxaca", demo: true });
    return ((await res.json()) as { id: string }).id;
  }

  it("answers JSON { letterId, itemId } and shows the demo mark beside the radio name on the item page", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const listenerId = await demoListener();
    const create = stubAnthropic();
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(translation("15 歳のときに大好きだった"));
    const res = await call("POST", "/admin/letters", { listenerId, itemId: item.id, body: "I loved this at 15" }, undefined, withKey);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { letterId: string; itemId: string };
    expect(out.itemId).toBe(item.id);
    const [l] = await listLettersForItem(env.DB, item.id);
    expect(l).toMatchObject({ id: out.letterId, body: "I loved this at 15", bodyJa: "15 歳のときに大好きだった", lang: "en", listenerId, radioName: "Marisol", demo: true });

    const page = await (await get(`/items/${item.id}`, await newSession())).text();
    expect(page).toContain("Marisolさん（Oaxaca）");
    expect(page).toContain(t("listener.demo"));
    expect(page).toContain("I loved this at 15");
  });

  it("answers 422 when moderation turns the letter down, and stores nothing", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const listenerId = await demoListener();
    stubAnthropic().mockResolvedValue(verdict({ ok: false, reason: "personal" }));
    const res = await call("POST", "/admin/letters", { listenerId, itemId: item.id, body: "x" }, undefined, withKey);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "letters.rejected" });
    expect(await listLettersForItem(env.DB, item.id)).toHaveLength(0);
  });

  it("answers 404 for an unknown listener, and 422 without itemId or url", async () => {
    const item = await insertItem(env.DB, itemDraft());
    expect((await call("POST", "/admin/letters", { listenerId: "nope", itemId: item.id, body: "x" })).status).toBe(404);
    const listenerId = await demoListener();
    expect((await call("POST", "/admin/letters", { listenerId, body: "x" })).status).toBe(422);
  });

  it("refuses to post as a listener that is not a demo account", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const real = await createListener(env.DB);
    expect((await call("POST", "/admin/letters", { listenerId: real.id, itemId: item.id, body: "x" })).status).toBe(403);
  });
});
