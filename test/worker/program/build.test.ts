import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import type { Env } from "../../../src/worker/env";
import { buildEpisode } from "../../../src/worker/program/build";
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
      for (const t of djTexts(seg.lines)) {
        expect(["お便りを読みます。", "ネットで見つけた声です。"].includes(t) || t.includes("が届いています")).toBe(true);
      }
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
  });

  it("composes readings only without calling Claude when there is no key", async () => {
    const f = await fixture();
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(create).not.toHaveBeenCalled();
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) expect(seg.lines[0]).toEqual({ type: "dj", text: "お便りを読みます。" });
  });

  it("falls back to readings only when Claude keeps returning a broken script", async () => {
    const f = await fixture();
    create.mockResolvedValue({ content: [{ type: "text", text: "はい" }] });
    const ep = await buildEpisode(keyed, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(true);
    for (const seg of ep.segments) expect(seg.lines[0]).toEqual({ type: "dj", text: "お便りを読みます。" });
  });

  it("returns verified=false when a found voice in the data has no source", async () => {
    const f = await fixture();
    await insertLetter(env.DB, letterDraft(f.i1, { kind: "found", listenerId: null, sourceAuthor: "@x", sourceUrl: null, body: "no link", bodyJa: "出典なし" }));
    const ep = await buildEpisode(keyless, env.DB, f.a, { size: 2, seed: "s" });
    expect(ep.verified).toBe(false);
    expect(ep.report.sources).toBe(false);
  });
});
