import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import type { Env } from "../../../src/worker/env";
import { buildEpisode, EpisodeUnverifiedError } from "../../../src/worker/program/build";
import type { Letter, Listener, ScriptLine } from "../../../src/worker/types";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test" } as Env;
const keyless = { ...env, ANTHROPIC_API_KEY: "" } as Env;
const script = (n: number, say = "静かな一曲です。") =>
  toolUse("write_script", { segments: Array.from({ length: n }, () => ({ say_before: say, say_after: "次も遠くから。" })) });
const segCount = (req: any) => (String(req.messages[0].content).match(/<segment /g) ?? []).length;
const djTexts = (lines: ScriptLine[]) => lines.filter((l) => l.type === "dj").map((l) => (l as { text: string }).text);

/** Listener A owns i0 (with A's own letter, which B answered); C wrote on i0 and on i1, a far item. */
async function fixture(): Promise<{ a: Listener; mine: Letter; mineReply: Letter; i0: string; i1: string }> {
  const a = await createListener(env.DB);
  const b = await createListener(env.DB);
  const c = await createListener(env.DB);
  const i0 = (await insertItem(env.DB, itemDraft({ title: "近くの曲" }))).id;
  const i1 = (await insertItem(env.DB, itemDraft({ title: "遠くの曲", previewUrl: null }))).id;
  const mine = await insertLetter(env.DB, letterDraft(i0, { listenerId: a.id, body: "A の一通です。" , bodyJa: "A の一通です。"}));
  await insertLetter(env.DB, letterDraft(i0, { listenerId: c.id, radioName: "しずく", place: "松本", body: "雨の日に聴きました。", bodyJa: "雨の日に聴きました。" }));
  await insertLetter(env.DB, letterDraft(i0, { kind: "watashimo", listenerId: b.id, radioName: "あおい", place: "那覇", parentLetterId: mine.id, body: "私も", bodyJa: "私も" }));
  const mineReply = await insertLetter(env.DB, letterDraft(i0, { kind: "reply", listenerId: b.id, radioName: "あおい", place: "那覇", parentLetterId: mine.id, body: "わかります", bodyJa: "わかります" }));
  await insertLetter(env.DB, letterDraft(i1, { listenerId: c.id, radioName: "しずく", place: "松本", body: "遠い国の歌。", bodyJa: "遠い国の歌。" }));
  return { a: { ...a, dial: 0 }, mine, mineReply, i0, i1 };
}

let create: ReturnType<typeof stubAnthropic>;
beforeEach(async () => {
  await resetDb(env.DB);
  create = stubAnthropic();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildEpisode", () => {
  it("builds a verified episode with the DJ's lines and the listener's reactions", async () => {
    const f = await fixture();
    create.mockImplementation(async (req) => script(segCount(req)));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep).toMatchObject({ listenerId: f.a.id, verified: true });
    expect(ep.report).toEqual({ verbatim: true, sources: true, topical: true, pii: true, details: [] });
    expect(ep.segments.map((s) => s.itemId).sort()).toEqual([f.i0, f.i1].sort());
    const near = ep.segments.find((s) => s.itemId === f.i0)!;
    expect(djTexts(near.lines)).toContain("静かな一曲です。");
    expect(djTexts(near.lines)).toContain("あおいさん（那覇）から『私も』が届いています");
    expect(near.lines).toContainEqual(expect.objectContaining({ type: "letter", letterId: f.mineReply.id, text: "わかります" }));
    // The listener's own letter is never read back to them.
    expect(near.lines.some((l) => l.type === "letter" && l.letterId === f.mine.id)).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(typeof ep.id).toBe("string");
  });

  it("asks once more when verification fails, then falls back to readings only", async () => {
    const f = await fixture();
    create.mockImplementation(async (req) => script(segCount(req), "今年いちばんの一曲です。"));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) {
      expect(seg.lines.filter((l) => l.type === "dj").every((l) => l.type === "dj" && l.fixed === true)).toBe(true);
    }
  });

  it("uses the second script when the first one fails verification", async () => {
    const f = await fixture();
    create
      .mockImplementationOnce(async (req) => script(segCount(req), "今年の一曲です。"))
      .mockImplementationOnce(async (req) => script(segCount(req), "落ち着いた一曲です。"));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    expect(djTexts(ep.segments[0]!.lines)).toContain("落ち着いた一曲です。");
    const first = String(create.mock.calls[0]![0].messages[0].content);
    const second = String(create.mock.calls[1]![0].messages[0].content);
    expect(first).not.toContain("前回の台本");
    expect(second).toContain("前回の台本で次の語が規則に触れました。言い換えてください");
    expect(second).toContain("topical: segment 1 line 1: 今年");
    expect(second).not.toContain("今年の一曲です。");
  });

  it("lets the DJ say the work's own year", async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE items SET year = 2016").run();
    create.mockImplementation(async (req) => script(segCount(req), "2016年の作品です。"));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(ep.verified).toBe(true);
    expect(djTexts(ep.segments[0]!.lines)).toContain("2016年の作品です。");
  });

  it("logs the HTTP status when the script call fails, and reads letters only", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    create.mockImplementation(async () => {
      throw new Error("unused");
    });
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } })));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    expect(ep.segments[0]!.lines[0]).toEqual({ type: "dj", text: expect.stringMatching(/からのお便りです。$/), fixed: true });
    expect(warn.mock.calls.some((c) => c.includes("status 401"))).toBe(true);
  });

  it("composes readings only without calling Claude when there is no key", async () => {
    const f = await fixture();
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).not.toHaveBeenCalled();
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) expect(seg.lines[0]).toEqual({ type: "dj", text: expect.stringMatching(/からのお便りです。$/), fixed: true });
  });

  it("falls back to readings only when Claude keeps returning a broken script", async () => {
    const f = await fixture();
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) expect(seg.lines[0]).toEqual({ type: "dj", text: expect.stringMatching(/からのお便りです。$/), fixed: true });
  });

  it("drops a found voice without a source and still verifies", async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = await insertLetter(env.DB, letterDraft(f.i1, { kind: "found", listenerId: null, sourceAuthor: "@x", sourceUrl: null, body: "no link", bodyJa: "出典なし" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    expect(ep.segments.flatMap((s) => s.lines).some((l) => l.type === "letter" && l.letterId === bad.id)).toBe(false);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("without a source"))).toBe(true);
  });

  it("speaks a found voice's author and site", async () => {
    const f = await fixture();
    await insertLetter(env.DB, letterDraft(f.i1, { kind: "found", listenerId: null, sourceAuthor: "@jazzcat", sourceUrl: "https://youtu.be/x", body: "so good", bodyJa: "とてもいい" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    const texts = ep.segments.flatMap((s) => djTexts(s.lines));
    expect(texts).toContain("ネットで見つけた声です。@jazzcatさん、YouTubeのコメントから。");
  });

  it("verifies a found voice from a non-YouTube site and says the host", async () => {
    const f = await fixture();
    await insertLetter(env.DB, letterDraft(f.i1, { kind: "found", listenerId: null, sourceAuthor: "ゆき", sourceUrl: "https://note.com/yuki/n/abc", body: "遠い歌", bodyJa: "遠い歌" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    expect(ep.segments.flatMap((s) => djTexts(s.lines))).toContain("ネットで見つけた声です。ゆきさん、note.comのコメントから。");
  });

  it("does not count template wording as a quote when a letter happens to contain it", async () => {
    const f = await fixture();
    await insertLetter(env.DB, letterDraft(f.i1, { listenerId: null, radioName: "ゆう", place: "", body: "ネットで見つけた声ですよね、これ。", bodyJa: "ネットで見つけた声ですよね、これ。" }));
    await insertLetter(env.DB, letterDraft(f.i1, { kind: "found", listenerId: null, sourceAuthor: "@jazzcat", sourceUrl: "https://youtu.be/x", body: "so good", bodyJa: "とてもいい" }));
    await insertLetter(env.DB, letterDraft(f.i0, { listenerId: null, radioName: "ゆう", place: "", body: "あおいさん(那覇)から『私も』が届いていますね", bodyJa: "あおいさん(那覇)から『私も』が届いていますね" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    expect(ep.report.pii).toBe(true);
    const texts = ep.segments.flatMap((s) => djTexts(s.lines));
    expect(texts).toContain("ネットで見つけた声です。@jazzcatさん、YouTubeのコメントから。");
    expect(texts).toContain("あおいさん（那覇）から『私も』が届いています");
  });

  it("still fails a fixed line whose filled-in name quotes a letter", async () => {
    const f = await fixture();
    await insertLetter(env.DB, letterDraft(f.i0, { kind: "watashimo", listenerId: null, radioName: "雨の日に聴きました。", place: "", parentLetterId: f.mine.id, body: "私も", bodyJa: "私も" }));
    const err = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EpisodeUnverifiedError);
    expect((err as EpisodeUnverifiedError).report.details.some((d) => d.includes("quotes a letter"))).toBe(true);
  });

  it("verifies readings only when a reaction's radio name looks like an email address", async () => {
    const f = await fixture();
    await insertLetter(env.DB, letterDraft(f.i0, { kind: "watashimo", listenerId: null, radioName: "a@b.co", place: "", parentLetterId: f.mine.id, body: "私も", bodyJa: "私も" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    expect(ep.segments.flatMap((s) => djTexts(s.lines))).toContain("a@b.coさんから『私も』が届いています");
  });

  it("a segment whose only letters are sourceless found voices is dropped", async () => {
    const f = await fixture();
    const lone = (await insertItem(env.DB, itemDraft({ title: "出典のない曲" }))).id;
    await insertLetter(env.DB, letterDraft(lone, { kind: "found", listenerId: null, sourceAuthor: "@x", sourceUrl: null, body: "no link", bodyJa: "出典なし" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 6, seed: "s" });
    expect(ep.segments.map((s) => s.itemId)).not.toContain(lone);
    expect(ep.segments.map((s) => s.itemId).sort()).toEqual([f.i0, f.i1].sort());
    expect(ep.verified).toBe(true);
  });

  it("an echo segment with no readable letter still airs with its reaction lines", async () => {
    const f = await fixture();
    // A work only the listener wrote about, answered by someone else since the last episode.
    const echo = (await insertItem(env.DB, itemDraft({ title: "返事のあった曲" }))).id;
    const own = await insertLetter(env.DB, letterDraft(echo, { listenerId: f.a.id, body: "私の一通。", bodyJa: "私の一通。" }));
    const b = await createListener(env.DB);
    await insertLetter(env.DB, letterDraft(echo, { kind: "reply", listenerId: b.id, radioName: "そら", place: "熊本", parentLetterId: own.id, body: "届きました", bodyJa: "届きました" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 3, seed: "s" });
    const seg = ep.segments.find((s) => s.itemId === echo)!;
    expect(seg).toBeDefined();
    expect(seg.lines).toContainEqual(expect.objectContaining({ type: "letter", text: "届きました", kind: "reply" }));
    expect(seg.lines.some((l) => l.type === "letter" && l.letterId === own.id)).toBe(false);
    expect(ep.verified).toBe(true);
  });

  it("an episode can end up with no segment at all when every letter is sourceless", async () => {
    const lone = (await insertItem(env.DB, itemDraft({ title: "出典のない曲" }))).id;
    await insertLetter(env.DB, letterDraft(lone, { kind: "found", listenerId: null, sourceAuthor: "@x", sourceUrl: null, body: "no link", bodyJa: "出典なし" }));
    const ep = await buildEpisode(keyless, env.DB, await createListener(env.DB), { station: { kind: "world" }, seed: "s" });
    expect(ep.segments).toEqual([]);
  });

  it("throws EpisodeUnverifiedError when even the readings-only episode fails", async () => {
    const f = await fixture();
    // A reaction whose radio name is the listener's own id: the fixed line would read the account aloud.
    await insertLetter(env.DB, letterDraft(f.i0, { kind: "watashimo", listenerId: null, radioName: f.a.id, place: "", parentLetterId: f.mine.id, body: "私も", bodyJa: "私も" }));
    const err = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EpisodeUnverifiedError);
    expect((err as EpisodeUnverifiedError).report.pii).toBe(false);
  });

  it("a public station builds a verified episode from a favourite someone has written about", async () => {
    const owner = await createListener(env.DB);
    const guest = await createListener(env.DB);
    const writer = await createListener(env.DB);
    const item = (await insertItem(env.DB, itemDraft({ title: "お気に入り" }))).id;
    const bare = (await insertItem(env.DB, itemDraft({ title: "まだ誰も書いていない" }))).id;
    await upsertHistory(env.DB, [
      { listenerId: owner.id, itemId: item, source: "manual", occurredAt: null, rank: 1 },
      { listenerId: owner.id, itemId: bare, source: "manual", occurredAt: null, rank: 2 },
    ]);
    await insertLetter(env.DB, letterDraft(item, { listenerId: writer.id, body: "好きです。", bodyJa: "好きです。" }));
    const ep = await buildEpisode(keyless, env.DB, guest, { station: { kind: "public", ownerId: owner.id }, seed: "t" });
    expect(ep.verified).toBe(true);
    expect(ep.listenerId).toBe(guest.id);
    expect(ep.segments.map((s) => s.itemId)).toEqual([item]);
    expect(ep.segments[0]?.lines.filter((l) => l.type === "letter")).toHaveLength(1);
  });

});
