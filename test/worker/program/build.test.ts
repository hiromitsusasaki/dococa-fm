import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertEpisode } from "../../../src/worker/db/episodes";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import { getUnits, upsertUnit } from "../../../src/worker/db/units";
import type { Env } from "../../../src/worker/env";
import { buildEpisode, EpisodeUnverifiedError } from "../../../src/worker/program/build";
import type { Letter, Listener, ScriptLine } from "../../../src/worker/types";
import { stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test" } as Env;
const keyless = { ...env, ANTHROPIC_API_KEY: "" } as Env;
const unitReply = (intro = "静かな一曲です。", after = "いいお便りでした。") => toolUse("write_unit", { intro, after });
const storeUnit = (letterId: string, intro: string, after: string, verified = true) =>
  upsertUnit(env.DB, { letterId, lang: "ja", intro, after, verified, audioReady: false });
const texts = (lines: ScriptLine[]) => lines.map((l) => (l.type === "letter" ? `letter:${l.letterId}` : (l as { text: string }).text));
const djTexts = (lines: ScriptLine[]) => lines.filter((l) => l.type === "dj").map((l) => (l as { text: string }).text);

/** Listener A owns i0 (with A's own letter, which B answered); C wrote on i0 and on i1, a far item. */
async function fixture(): Promise<{ a: Listener; mine: Letter; mineReply: Letter; near: Letter; far: Letter; i0: string; i1: string }> {
  const a = await createListener(env.DB);
  const b = await createListener(env.DB);
  const c = await createListener(env.DB);
  const i0 = (await insertItem(env.DB, itemDraft({ title: "近くの曲" }))).id;
  const i1 = (await insertItem(env.DB, itemDraft({ title: "遠くの曲", previewUrl: null }))).id;
  const mine = await insertLetter(env.DB, letterDraft(i0, { listenerId: a.id, body: "A の一通です。" , bodyJa: "A の一通です。"}));
  const near = await insertLetter(env.DB, letterDraft(i0, { listenerId: c.id, radioName: "しずく", place: "松本", body: "雨の日に聴きました。", bodyJa: "雨の日に聴きました。" }));
  await insertLetter(env.DB, letterDraft(i0, { kind: "watashimo", listenerId: b.id, radioName: "あおい", place: "那覇", parentLetterId: mine.id, body: "私も", bodyJa: "私も" }));
  const mineReply = await insertLetter(env.DB, letterDraft(i0, { kind: "reply", listenerId: b.id, radioName: "あおい", place: "那覇", parentLetterId: mine.id, body: "わかります", bodyJa: "わかります" }));
  const far = await insertLetter(env.DB, letterDraft(i1, { listenerId: c.id, radioName: "しずく", place: "松本", body: "遠い国の歌。", bodyJa: "遠い国の歌。" }));
  return { a: { ...a, dial: 0 }, mine, mineReply, near, far, i0, i1 };
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
  it("with every unit stored, asks Claude nothing and speaks each unit around its letter", async () => {
    const f = await fixture();
    await storeUnit(f.near.id, "近くの紹介です。", "近くの感想です。");
    await storeUnit(f.far.id, "遠くの紹介です。", "遠くの感想です。");
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).not.toHaveBeenCalled();
    expect(ep).toMatchObject({ listenerId: f.a.id, verified: true });
    expect(ep.report).toEqual({ verbatim: true, sources: true, topical: true, pii: true, details: [] });
    expect(ep.segments.map((s) => s.itemId).sort()).toEqual([f.i0, f.i1].sort());
    const near = ep.segments.find((s) => s.itemId === f.i0)!;
    const said = texts(near.lines);
    // The intro follows the open bridge, whichever letter the shuffle reads first.
    expect(said[1]).toBe("近くの紹介です。");
    const at = said.indexOf(`letter:${f.near.id}`);
    expect(said.slice(at - 1, at + 2)).toEqual(["松本にお住まいの、しずくさんからのお便りです。", `letter:${f.near.id}`, "近くの感想です。"]);
    expect(said).toContain("那覇にお住まいの、あおいさんから『私も』が届いています");
    expect(near.lines).toContainEqual(expect.objectContaining({ type: "letter", letterId: f.mineReply.id, text: "わかります" }));
    // The listener's own letter is never read back to them.
    expect(near.lines.some((l) => l.type === "letter" && l.letterId === f.mine.id)).toBe(false);
    const far = texts(ep.segments.find((s) => s.itemId === f.i1)!.lines);
    expect(far.slice(1, 5)).toEqual(["遠くの紹介です。", "松本にお住まいの、しずくさんからのお便りです。", `letter:${f.far.id}`, "遠くの感想です。"]);
    expect(typeof ep.id).toBe("string");
  });

  it("for an english listener, makes english units, reads bodyEn and stores lang en", async () => {
    const f = await fixture();
    await upsertUnit(env.DB, { letterId: f.near.id, lang: "ja", intro: "近くの紹介です。", after: "近くの感想です。", verified: true, audioReady: false });
    const near = await insertLetter(env.DB, letterDraft(f.i1, { listenerId: f.near.listenerId, radioName: "しずく", place: "松本", placeCountry: "JP", placeRegion: "20", body: "雪の朝に。", bodyJa: "雪の朝に。", bodyEn: "On a snowy morning." }));
    create.mockResolvedValue(unitReply("A quiet piece.", "A lovely letter."));
    const ep = await buildEpisode(keyed, env.DB, { ...f.a, lang: "en" }, { size: 2, seed: "s" });
    expect(ep).toMatchObject({ lang: "en", verified: true });
    expect(create.mock.calls.every((c) => String(c[0].system).startsWith("You are"))).toBe(true);
    const all = ep.segments.flatMap((s) => s.lines);
    expect(all).toContainEqual(expect.objectContaining({ type: "letter", letterId: near.id, text: "On a snowy morning." }));
    expect(all).toContainEqual(expect.objectContaining({ type: "letter", letterId: f.near.id, text: f.near.body }));
    expect(djTexts(all)).toContain("A letter from しずく, who lives in Nagano, Japan.");
    expect(djTexts(all)).not.toContain("近くの紹介です。");
    expect(djTexts(all)).toContain("A quiet piece.");
    expect((await getUnits(env.DB, [f.near.id, near.id], "en")).size).toBe(2);
  });

  it("with one unit missing, makes exactly that one with one call and stores it", async () => {
    const f = await fixture();
    await storeUnit(f.near.id, "近くの紹介です。", "近くの感想です。");
    create.mockResolvedValue(unitReply("遠くの紹介です。", "遠くの感想です。"));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(String(create.mock.calls[0]![0].messages[0].content)).toContain("遠い国の歌。");
    expect(ep.verified).toBe(true);
    expect(texts(ep.segments.find((s) => s.itemId === f.i1)!.lines)).toContain("遠くの感想です。");
    expect((await getUnits(env.DB, [f.far.id], "ja")).get(f.far.id)).toMatchObject({ intro: "遠くの紹介です。", verified: true });
  });

  it("drops from the programme a stored unit that quotes another letter of its segment, and leaves the row alone", async () => {
    const f = await fixture();
    const second = await insertLetter(env.DB, letterDraft(f.i0, { listenerId: null, radioName: "ゆう", place: "", body: "海の見える駅で聴いていました。", bodyJa: "海の見える駅で聴いていました。" }));
    await storeUnit(f.near.id, "近くの紹介です。", "海の見える駅で聴いていました、という方も。");
    await storeUnit(second.id, "二通目の紹介です。", "二通目の感想です。");
    await storeUnit(f.far.id, "遠くの紹介です。", "遠くの感想です。");
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).not.toHaveBeenCalled();
    expect(ep.verified).toBe(true);
    const near = texts(ep.segments.find((s) => s.itemId === f.i0)!.lines);
    expect(near).toContain(`letter:${second.id}`);
    expect(near.some((x) => x.includes("海の見える駅で聴いていました、"))).toBe(false);
    expect(near).not.toContain("近くの紹介です。");
    expect(near).not.toContain("二通目の感想です。");
    // Only the failing segment loses its units.
    expect(texts(ep.segments.find((s) => s.itemId === f.i1)!.lines)).toContain("遠くの感想です。");
    expect((await getUnits(env.DB, [f.near.id], "ja")).get(f.near.id)).toMatchObject({ verified: true });
  });

  it("does not speak a unit stored unverified", async () => {
    const f = await fixture();
    await storeUnit(f.near.id, "近くの紹介です。", "近くの感想です。", false);
    await storeUnit(f.far.id, "遠くの紹介です。", "遠くの感想です。", false);
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).not.toHaveBeenCalled();
    for (const seg of ep.segments) expect(seg.lines.filter((l) => l.type === "dj").every((l) => l.type === "dj" && l.fixed === true)).toBe(true);
  });

  it("makes new units that fail verification twice unverified, and reads with fixed lines", async () => {
    const f = await fixture();
    create.mockResolvedValue(unitReply("今年いちばんの一曲です。"));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).toHaveBeenCalledTimes(4);
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) expect(seg.lines.filter((l) => l.type === "dj").every((l) => l.type === "dj" && l.fixed === true)).toBe(true);
    expect([...(await getUnits(env.DB, [f.near.id, f.far.id], "ja")).values()].map((u) => u.verified)).toEqual([false, false]);
  });

  it("lets the DJ say the work's own year", async () => {
    const f = await fixture();
    await env.DB.prepare("UPDATE items SET year = 2016").run();
    create.mockResolvedValue(unitReply("2016年の作品です。"));
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(ep.verified).toBe(true);
    expect(djTexts(ep.segments.find((s) => s.itemId === f.i1)!.lines)).toContain("2016年の作品です。");
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
    expect(ep.segments[0]!.lines[1]).toEqual({ type: "dj", text: expect.stringMatching(/からのお便りです。$/), fixed: true });
    expect(warn.mock.calls.some((c) => c.includes("status 401"))).toBe(true);
  });

  it("composes fixed lines only without calling Claude when there is no key and no unit", async () => {
    const f = await fixture();
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).not.toHaveBeenCalled();
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) expect(seg.lines[1]).toEqual({ type: "dj", text: expect.stringMatching(/からのお便りです。$/), fixed: true });
  });

  it("composes fixed lines only without calling Claude when today's units are at UNIT_DAILY_LIMIT", async () => {
    const f = await fixture();
    create.mockResolvedValue(unitReply());
    for (const limit of ["0", "1"]) {
      if (limit === "1") await storeUnit(f.mine.id, "前の日の紹介です。", "前の日の感想です。", false);
      const ep = await buildEpisode({ ...keyed, UNIT_DAILY_LIMIT: limit } as Env, env.DB, f.a, { size: 2, seed: "s" });
      expect(ep.verified).toBe(true);
      for (const seg of ep.segments) expect(seg.lines[1]).toEqual({ type: "dj", text: expect.stringMatching(/からのお便りです。$/), fixed: true });
    }
    expect(create).not.toHaveBeenCalled();
    expect((await getUnits(env.DB, [f.near.id, f.far.id], "ja")).size).toBe(0);
  });

  it("falls back to readings only when Claude keeps returning a broken script", async () => {
    const f = await fixture();
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) expect(seg.lines[1]).toEqual({ type: "dj", text: expect.stringMatching(/からのお便りです。$/), fixed: true });
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
    await insertLetter(env.DB, letterDraft(f.i0, { listenerId: null, radioName: "ゆう", place: "", body: "那覇にお住まいの、あおいさんから『私も』が届いていますね", bodyJa: "那覇にお住まいの、あおいさんから『私も』が届いていますね" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    expect(ep.report.pii).toBe(true);
    const texts = ep.segments.flatMap((s) => djTexts(s.lines));
    expect(texts).toContain("ネットで見つけた声です。@jazzcatさん、YouTubeのコメントから。");
    expect(texts).toContain("那覇にお住まいの、あおいさんから『私も』が届いています");
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

  it("reads a reply once when it is both a selected letter and a reaction in the same segment", async () => {
    const f = await fixture();
    // `mineReply` answers the listener's own letter on i0, so it airs as a reaction; selection must not read it again.
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 3, seed: "s" });
    const reads = ep.segments.flatMap((s) => s.lines).filter((l) => l.type === "letter" && l.letterId === f.mineReply.id);
    expect(reads).toHaveLength(1);
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

  it("a public station bridges its later segments with the neutral next line", async () => {
    const owner = await createListener(env.DB);
    const guest = await createListener(env.DB);
    const writer = await createListener(env.DB);
    const ids: string[] = [];
    for (const title of ["一つ目", "二つ目"]) {
      const id = (await insertItem(env.DB, itemDraft({ title }))).id;
      ids.push(id);
      await insertLetter(env.DB, letterDraft(id, { listenerId: writer.id, body: `${title}が好きです。`, bodyJa: `${title}が好きです。` }));
    }
    await upsertHistory(env.DB, ids.map((itemId, i) => ({ listenerId: owner.id, itemId, source: "manual" as const, occurredAt: null, rank: i + 1 })));
    const ep = await buildEpisode(keyless, env.DB, guest, { station: { kind: "public", ownerId: owner.id }, seed: "t" });
    expect(ep.verified).toBe(true);
    expect(ep.segments).toHaveLength(2);
    expect(ep.segments[1]!.lines[0]).toMatchObject({ bridge: "bridge.next" });
    expect(ep.segments.flatMap((s) => s.lines).some((l) => l.type === "dj" && l.bridge === "bridge.near")).toBe(false);
  });
});
