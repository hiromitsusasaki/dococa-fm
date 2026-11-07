import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../../src/worker/index";
import { createListener, getListener } from "../../../src/worker/db/listeners";
import { getItemVecs, insertItem } from "../../../src/worker/db/items";
import { fakeAi } from "../../helpers/ai";
import { insertLetter, listLettersForItem } from "../../../src/worker/db/letters";
import { t } from "../../../src/worker/i18n/t";
import * as prepare from "../../../src/worker/program/prepare";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { json, stubFetch } from "../../helpers/fetch";
import { itemDraft, letterDraft } from "../db/helpers";
import { get, newSession } from "./helpers";

const TOKEN = "admin-token-test";
const e = { ...env, ADMIN_TOKEN: TOKEN };

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, withEnv: object = e) =>
  app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) }, withEnv);

const voice = (over: Record<string, unknown> = {}) => ({ body: "十五の夏に、この曲だけ聴いていました。", author: "ゆうき", url: "https://www.youtube.com/watch?v=abc&lc=c1", ...over });

beforeEach(async () => {
  await resetDb(env.DB);
  // The hooks run the real preparation unless a test turns it into a spy.
  vi.spyOn(prepare, "prepareLetter").mockResolvedValue({ units: 0, audio: 0, failed: 0 });
});
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
    for (const [m, p] of [["POST", "/admin/found"], ["POST", "/admin/items"], ["GET", "/admin/items/x"], ["POST", "/admin/episodes"], ["POST", "/admin/letters/x/reject"], ["POST", "/admin/prepare"]]) {
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

  it("prepares each stored voice after the response", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const res = await post({ itemId: item.id, voices: [voice(), voice({ url: "https://www.youtube.com/watch?v=abc&lc=c2" })] });
    const { letterIds } = (await res.json()) as { letterIds: string[] };
    expect(letterIds).toHaveLength(2);
    expect(vi.mocked(prepare.prepareLetter).mock.calls.map((c) => c[2])).toEqual(letterIds);
  });

  it("prepares nothing when the batch stored nothing", async () => {
    const item = await insertItem(env.DB, itemDraft());
    await post({ itemId: item.id, voices: [voice()] });
    vi.mocked(prepare.prepareLetter).mockClear();
    await post({ itemId: item.id, voices: [voice()] });
    expect(prepare.prepareLetter).not.toHaveBeenCalled();
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

describe("POST /admin/prepare", () => {
  const keyed = { ...e, ANTHROPIC_API_KEY: "sk-test", GOOGLE_TTS_SA_JSON: "" };
  const post = (body?: unknown, headers?: Record<string, string>) => call("POST", "/admin/prepare", body, headers, keyed);

  async function seedLetters(n: number) {
    const item = await insertItem(env.DB, itemDraft());
    for (let i = 0; i < n; i++) await insertLetter(env.DB, letterDraft(item.id, { body: `手紙${i}`, bodyJa: `手紙${i}` }));
  }

  it("answers 401 without the token", async () => {
    expect((await post({}, {})).status).toBe(401);
  });

  it("makes the missing units and reports what is left", async () => {
    await seedLetters(2);
    vi.mocked(prepare.prepareLetter).mockRestore();
    stubAnthropic().mockResolvedValue(toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ units: 4, audio: 0, failed: 0, remaining: { vectors: 1, units: { ja: 0, en: 0 }, audio: { ja: 2, en: 2 }, gaveUp: { ja: 0, en: 0 } } });
  });

  it("takes a limit of 1 to 50, 20 by default", async () => {
    await seedLetters(3);
    vi.mocked(prepare.prepareLetter).mockRestore();
    const create = stubAnthropic();
    create.mockResolvedValue(toolUse("write_unit", { intro: "静かな一曲です。", after: "いいお便りでした。" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The limit is the run's budget across both languages.
    expect(await (await post({ limit: 1 })).json()).toMatchObject({ units: 1, remaining: { units: { ja: 2, en: 3 } } });
    expect(await (await post()).json()).toMatchObject({ units: 5, remaining: { units: { ja: 0, en: 0 } } });
    for (const limit of [0, 51, 1.5, "5"]) expect((await post({ limit })).status).toBe(422);
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

  it("has the new work's vector made after answering, from its title and creator only", async () => {
    stubFetch([
      [OEMBED, () => json({ title: "Some Song", author_name: "Some Channel", thumbnail_url: "https://i.ytimg.com/x.jpg" })],
      ["https://itunes.apple.com", () => json({ resultCount: 0, results: [] })],
    ]);
    const { AI, calls } = fakeAi();
    const res = await call("POST", "/admin/items", { url: "https://www.youtube.com/watch?v=abcdefghijk" }, undefined, { ...e, AI });
    const { item } = (await res.json()) as { item: { id: string } };
    expect(Object.keys(item)).not.toContain("vec");
    await vi.waitFor(async () => expect((await getItemVecs(env.DB, [item.id])).size).toBe(1));
    expect(calls).toEqual([{ model: "@cf/baai/bge-m3", text: ["Some Song — Some Channel [video]"] }]);
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
    const res = await call("POST", "/admin/episodes", { listenerId: listener.id }, undefined, { ...e, GOOGLE_TTS_SA_JSON: "k" });
    expect(await res.json()).toMatchObject({ cloudTts: true });
  });

  it("answers 404 for an unknown listener and 422 without one", async () => {
    expect((await call("POST", "/admin/episodes", { listenerId: "nope" })).status).toBe(404);
    expect((await call("POST", "/admin/episodes", {})).status).toBe(422);
  });

  it("makes one segment by default and as many as the eval asks for, up to six", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = await createListener(env.DB);
    for (let n = 0; n < 8; n++) {
      const item = await insertItem(env.DB, itemDraft({ title: `t${n}`, externalIds: { itunes: String(500 + n) } }));
      await insertLetter(env.DB, letterDraft(item.id));
    }
    const segments = async (body: object) => {
      const made = (await (await call("POST", "/admin/episodes", { listenerId: listener.id, ...body })).json()) as { id: string };
      return ((await (await call("GET", `/admin/episodes/${made.id}`)).json()) as { segments: unknown[] }).segments.length;
    };
    expect(await segments({})).toBe(1);
    expect(await segments({ size: 6 })).toBe(6);
    for (const size of [0, 7, 1.5]) expect((await call("POST", "/admin/episodes", { listenerId: listener.id, size })).status).toBe(422);
  });
});

describe("POST /admin/rejudge", () => {
  const keyed = { ...e, ANTHROPIC_API_KEY: "sk-test" };
  const rejudge = (body?: unknown) => call("POST", "/admin/rejudge", body ?? {}, undefined, keyed);
  const verdictFor = (bad: Record<string, string>) => (req: any) => {
    const user = String(req.messages[0].content);
    const hit = Object.keys(bad).find((b) => user.includes(`<letter>${b}</letter>`));
    return toolUse("judge_letter", hit ? { ok: false, reason: bad[hit] } : { ok: true });
  };
  const status = async (id: string) => (await env.DB.prepare("SELECT status FROM letters WHERE id = ?").bind(id).first<{ status: string }>())?.status;

  it("judges only letters, found voices and replies, and rejects what the judge turns down", async () => {
    const create = stubAnthropic();
    create.mockImplementation(verdictFor({ けなす: "negative", わいせつ: "obscene" }));
    const item = await insertItem(env.DB, itemDraft({ title: "題名X", creator: "作者Y" }));
    const bad = await insertLetter(env.DB, letterDraft(item.id, { body: "けなす" }));
    const bad2 = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", body: "わいせつ", sourceUrl: "https://example.com/1", sourceAuthor: "a" }));
    const fine = await insertLetter(env.DB, letterDraft(item.id, { kind: "reply", body: "いい" }));
    const watashimo = await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", body: "けなす" }));
    const res = await rejudge();
    expect(res.status).toBe(200);
    const out = (await res.json()) as { judged: number; rejected: { id: string; reason: string }[]; skipped: number; next: string | null };
    expect(out.judged).toBe(3);
    expect(out.skipped).toBe(0);
    expect(out.next).toBeNull();
    expect(out.rejected.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: bad.id, reason: "negative" },
        { id: bad2.id, reason: "obscene" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(await status(bad.id)).toBe("rejected");
    expect(await status(bad2.id)).toBe("rejected");
    expect(await status(fine.id)).toBe("public");
    expect(await status(watashimo.id)).toBe("public");
    expect(create).toHaveBeenCalledTimes(3);
    const sent = create.mock.calls.map((c) => String(c[0].messages[0].content)).join("\n");
    expect(sent).toContain("題名: 題名X");
    expect(sent).toContain("作者: 作者Y");
  });

  it("never judges a letter that is already rejected", async () => {
    const create = stubAnthropic();
    create.mockImplementation(verdictFor({}));
    const item = await insertItem(env.DB, itemDraft());
    const gone = await insertLetter(env.DB, letterDraft(item.id, { status: "rejected" }));
    const out = (await (await rejudge()).json()) as { judged: number };
    expect(out.judged).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect(await status(gone.id)).toBe("rejected");
  });

  it("skips a letter whose judgement throws, leaves it public, and logs its id and the error name, never the text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const create = stubAnthropic();
    create.mockResolvedValue({ content: [{ type: "text", text: "hmm" }] });
    const item = await insertItem(env.DB, itemDraft());
    const l = await insertLetter(env.DB, letterDraft(item.id, { body: "ひみつの本文です" }));
    const out = (await (await rejudge()).json()) as { judged: number; skipped: number; rejected: unknown[] };
    expect(out).toMatchObject({ judged: 0, skipped: 1, rejected: [] });
    expect(await status(l.id)).toBe("public");
    const logged = warn.mock.calls.map((c) => c.join(" "));
    expect(logged.some((line) => /^\[dococa\] rejudge skipped \S+ \S+$/.test(line) && line.includes(l.id))).toBe(true);
    expect(logged.join("\n")).not.toContain("ひみつ");
  });

  it("paginates by the id cursor", async () => {
    const create = stubAnthropic();
    create.mockImplementation(verdictFor({}));
    const item = await insertItem(env.DB, itemDraft());
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push((await insertLetter(env.DB, letterDraft(item.id, { body: `b${n}` }))).id);
    ids.sort();
    const first = (await (await rejudge({ limit: 2 })).json()) as { judged: number; next: string | null };
    expect(first).toMatchObject({ judged: 2, next: ids[1] });
    const second = (await (await rejudge({ limit: 2, after: first.next })).json()) as { judged: number; next: string | null };
    expect(second).toMatchObject({ judged: 2, next: ids[3] });
    const third = (await (await rejudge({ limit: 2, after: second.next })).json()) as { judged: number; next: string | null };
    expect(third).toMatchObject({ judged: 1, next: null });
    expect(create).toHaveBeenCalledTimes(5);
  });

  it("answers 422 for a limit outside 1-50, and 401 without the token", async () => {
    for (const limit of [0, 51, 101, 1.5]) expect((await rejudge({ limit })).status).toBe(422);
    expect((await call("POST", "/admin/rejudge", {}, {}, keyed)).status).toBe(401);
  });
});

describe("GET /admin/episodes/:id", () => {
  it("returns the stored episode with its report for the operator", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const listener = await createListener(env.DB);
    const item = await insertItem(env.DB, itemDraft());
    await insertLetter(env.DB, letterDraft(item.id));
    const made = (await (await call("POST", "/admin/episodes", { listenerId: listener.id })).json()) as { id: string };
    const res = await call("GET", `/admin/episodes/${made.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; listenerId: string; segments: unknown[]; report: { verbatim: boolean } };
    expect(body).toMatchObject({ id: made.id, listenerId: listener.id });
    expect(Array.isArray(body.segments)).toBe(true);
    expect(typeof body.report.verbatim).toBe("boolean");
  });

  it("answers 404 for an unknown episode and 401 without the token", async () => {
    expect((await call("GET", "/admin/episodes/nope")).status).toBe(404);
    expect((await call("GET", "/admin/episodes/nope", undefined, {})).status).toBe(401);
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

  it("takes optional place codes and sets the place from their Japanese label", async () => {
    const make = async (body: Record<string, unknown>) => ((await (await call("POST", "/admin/listeners", { radioName: "A", place: "尾道、日本", demo: true, ...body })).json()) as { id: string }).id;
    expect(await getListener(env.DB, await make({ placeCountry: "JP", placeRegion: "34" }))).toMatchObject({ place: "広島", placeCountry: "JP", placeRegion: "34", demo: true });
    expect(await getListener(env.DB, await make({ placeCountry: "PT" }))).toMatchObject({ place: "ポルトガル", placeCountry: "PT", placeRegion: null });
    expect(await getListener(env.DB, await make({}))).toMatchObject({ place: "尾道、日本", placeCountry: null, placeRegion: null });
  });

  it("refuses an unknown country, a region of another country, a region without a country, and a region where none is listed", async () => {
    for (const body of [{ placeCountry: "XX" }, { placeCountry: "jp" }, { placeCountry: "JP", placeRegion: "CA" }, { placeRegion: "34" }, { placeCountry: "PT", placeRegion: "01" }, { placeCountry: "JP", placeRegion: "" }]) {
      expect((await call("POST", "/admin/listeners", { radioName: "A", place: "x", demo: true, ...body })).status, JSON.stringify(body)).toBe(422);
    }
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

    expect(prepare.prepareLetter).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prepare.prepareLetter).mock.calls[0]![2]).toBe(out.letterId);

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

describe("admin reactions and lists", () => {
  const withKey = { ...e, ANTHROPIC_API_KEY: "sk-test" };
  const verdict = (input: unknown) => ({ content: [{ type: "tool_use", id: "j", name: "judge_letter", input }] });
  const translation = (ja: string) => ({ content: [{ type: "tool_use", id: "t", name: "translate", input: { ja } }] });

  async function demo(radioName: string) {
    const res = await call("POST", "/admin/listeners", { radioName, place: "Oaxaca", demo: true });
    return ((await res.json()) as { id: string }).id;
  }
  async function parentLetter() {
    const item = await insertItem(env.DB, itemDraft());
    const author = await createListener(env.DB, { radioName: "Real", place: "Tokyo" });
    const letter = await insertLetter(env.DB, letterDraft(item.id, { listenerId: author.id, radioName: "Real" }));
    return { item, letter, author };
  }

  it("posts a 私も for a demo listener with no body, marks it demo, and answers 409 on a repeat", async () => {
    const { item, letter } = await parentLetter();
    const listenerId = await demo("Marisol");
    const post = () => call("POST", "/admin/letters", { listenerId, itemId: item.id, kind: "watashimo", parentLetterId: letter.id }, undefined, withKey);
    const first = await post();
    expect(first.status).toBe(200);
    const reactions = (await listLettersForItem(env.DB, item.id)).filter((l) => l.kind === "watashimo");
    expect(reactions).toHaveLength(1);
    expect(reactions[0]).toMatchObject({ parentLetterId: letter.id, listenerId, demo: true });
    expect((await post()).status).toBe(409);
    expect(prepare.prepareLetter).not.toHaveBeenCalled();
  });

  it("posts a reply through moderation and turns it down when the judge does", async () => {
    const { item, letter } = await parentLetter();
    const listenerId = await demo("Marisol");
    const create = stubAnthropic();
    create.mockResolvedValueOnce(verdict({ ok: true })).mockResolvedValueOnce(translation("私も好きです"));
    const ok = await call("POST", "/admin/letters", { listenerId, itemId: item.id, kind: "reply", parentLetterId: letter.id, body: "Me too" }, undefined, withKey);
    expect(ok.status).toBe(200);
    expect((await listLettersForItem(env.DB, item.id)).find((l) => l.kind === "reply")).toMatchObject({ body: "Me too", demo: true });
    expect(prepare.prepareLetter).not.toHaveBeenCalled();

    create.mockReset();
    create.mockResolvedValue(verdict({ ok: false, reason: "personal" }));
    const bad = await call("POST", "/admin/letters", { listenerId, itemId: item.id, kind: "reply", parentLetterId: letter.id, body: "x" }, undefined, withKey);
    expect(bad.status).toBe(422);
  });

  it("refuses a reaction to a missing parent and a plain letter without a body", async () => {
    const item = await insertItem(env.DB, itemDraft());
    const listenerId = await demo("Marisol");
    expect((await call("POST", "/admin/letters", { listenerId, itemId: item.id, kind: "watashimo", parentLetterId: "nope" }, undefined, withKey)).status).toBe(422);
    expect((await call("POST", "/admin/letters", { listenerId, itemId: item.id }, undefined, withKey)).status).toBe(422);
  });

  it("lists the demo listeners behind the token", async () => {
    const id = await demo("Marisol");
    await createListener(env.DB, { radioName: "Real", place: "x" });
    const res = await call("GET", "/admin/listeners.json");
    expect(await res.json()).toEqual({ listeners: [{ id, radioName: "Marisol" }] });
    expect((await call("GET", "/admin/listeners.json", undefined, {})).status).toBe(401);
  });

  it("lists public letters with their reactors and pages by cursor", async () => {
    const { item, letter, author } = await parentLetter();
    const second = await insertLetter(env.DB, letterDraft(item.id, { kind: "found", body: "found voice", bodyJa: "found voice", sourceUrl: "https://example.com/f", sourceAuthor: "a" }));
    const rejected = await insertLetter(env.DB, letterDraft(item.id, { status: "rejected" }));
    const marisol = await demo("Marisol");
    await call("POST", "/admin/letters", { listenerId: marisol, itemId: item.id, kind: "watashimo", parentLetterId: letter.id }, undefined, withKey);

    const res = await call("GET", "/admin/letters.json?limit=50");
    const { letters, next } = (await res.json()) as { letters: { id: string; kind: string; listenerId: string | null; demo: boolean; reactorIds: string[]; title: string }[]; next: string | null };
    expect(next).toBeNull();
    expect(letters.map((l) => l.id).sort()).toEqual([letter.id, second.id].sort());
    expect(letters.find((l) => l.id === letter.id)).toMatchObject({ kind: "letter", listenerId: author.id, demo: false, reactorIds: [marisol], title: item.title });
    expect(letters.find((l) => l.id === second.id)).toMatchObject({ kind: "found", listenerId: null, demo: false, reactorIds: [] });
    expect(letters.map((l) => l.id)).not.toContain(rejected.id);

    const page = (await (await call("GET", "/admin/letters.json?limit=1")).json()) as { letters: { id: string }[]; next: string };
    expect(page.letters).toHaveLength(1);
    const rest = (await (await call("GET", `/admin/letters.json?limit=1&after=${page.next}`)).json()) as { letters: { id: string }[] };
    expect(rest.letters[0]!.id).not.toBe(page.letters[0]!.id);
    expect((await call("GET", "/admin/letters.json", undefined, {})).status).toBe(401);
  });
});
