import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getItem, insertItem, setItemReading } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import type { Env } from "../../../src/worker/env";
import { composeEpisode } from "../../../src/worker/program/compose";
import { farBridgeIds, farBridges, withFarBridges } from "../../../src/worker/program/far-bridge";
import { verifyEpisode } from "../../../src/worker/program/verify";
import type { Item, Letter, Listener } from "../../../src/worker/types";
import { expectInstructedTool, stubAnthropic, toolUse } from "../../helpers/anthropic";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

const keyed = { ...env, ANTHROPIC_API_KEY: "sk-test" } as Env;
const keyless = { ...env, ANTHROPIC_API_KEY: "" } as Env;
const reply = (line: string) => toolUse("write_bridge", { line });

/** Listener A wrote about 「夜の窓」; the next work, 「遠い海」, is someone else's letter. */
async function fixture(): Promise<{ a: Listener; mine: Item; next: Item; letter: Letter; items: Map<string, Item>; letters: Map<string, Letter> }> {
  const a = await createListener(env.DB);
  const mine = await insertItem(env.DB, itemDraft({ title: "夜の窓", creator: "TOKYO BAND" }));
  await setItemReading(env.DB, mine.id, { creator: "トウキョウバンド" });
  const next = await insertItem(env.DB, itemDraft({ title: "遠い海", creator: "誰か", kind: "book" }));
  await insertLetter(env.DB, letterDraft(mine.id, { listenerId: a.id, body: "窓の外の灯りを思い出す曲。", bodyJa: "窓の外の灯りを思い出す曲。" }));
  const letter = await insertLetter(env.DB, letterDraft(next.id, { radioName: "しずく", place: "松本", body: "海の匂いがする本でした。", bodyJa: "海の匂いがする本でした。" }));
  return { a, mine: (await getItem(env.DB, mine.id))!, next, letter, items: new Map([[next.id, next]]), letters: new Map([[letter.id, letter]]) };
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

describe("farBridges", () => {
  it("before a far work, airs Claude's line naming one of the listener's works, not fixed, and the programme verifies", async () => {
    const f = await fixture();
    create.mockReturnValue(reply("あなたの好きな『夜の窓』とは少し違う毛色の一冊です。"));
    const bridges = await farBridges(keyed, env.DB, f.a, [f.next.id], f.items, f.letters, "ja");
    expect(bridges.get(f.next.id)).toEqual({ type: "dj", text: "あなたの好きな『夜の窓』とは少し違う毛色の一冊です。", bridge: "bridge.far" });
    expect(create).toHaveBeenCalledTimes(1);
    const req = create.mock.calls[0]![0];
    expectInstructedTool(req, "write_bridge");
    const prompt: string = req.messages[0].content;
    expect(prompt).toContain("題名: 夜の窓");
    expect(prompt).toContain("題名: 遠い海");
    expect(prompt).toContain("45 字以内");
    // Titles, creators and kinds only: no letter body reaches the prompt.
    expect(prompt).not.toContain("窓の外の灯り");
    expect(prompt).not.toContain("海の匂い");
    // In a programme it replaces the fixed far bridge and passes the checks.
    const plan = [
      { itemId: f.mine.id, slot: "near" as const, letterIds: [], reactionIds: [f.letter.id] },
      { itemId: f.next.id, slot: "far" as const, letterIds: [f.letter.id], reactionIds: [] },
    ];
    const items = new Map([...f.items, [f.mine.id, f.mine]]);
    const segments = withFarBridges(composeEpisode(plan, null, f.letters, items, "ja", "mine"), bridges);
    expect(segments[1]!.lines[0]).toEqual(bridges.get(f.next.id));
    const report = verifyEpisode(segments, f.letters, f.a, items, "ja");
    expect(report.details).toEqual([]);
  });

  it("voices the listener's work by its reading in `spoken`", async () => {
    const f = await fixture();
    create.mockReturnValue(reply("TOKYO BANDの『夜の窓』とは違う色の一冊です。"));
    const bridges = await farBridges(keyed, env.DB, f.a, [f.next.id], f.items, f.letters, "ja");
    expect(bridges.get(f.next.id)).toMatchObject({ text: "TOKYO BANDの『夜の窓』とは違う色の一冊です。", spoken: "トウキョウバンドの『夜の窓』とは違う色の一冊です。" });
  });

  it.each([
    ["fails verification (a count)", "『夜の窓』が好きな3人にも届いた一冊です。"],
    ["fails verification (playback)", "『夜の窓』のあとは、この一冊をどうぞ。"],
    ["says the next work's title", "『夜の窓』から『遠い海』へ。"],
    ["names none of the listener's works", "少し遠くの一冊です。"],
    ["is longer than 45 characters", `『夜の窓』${"とても".repeat(20)}遠い一冊です。`],
  ])("keeps the fixed bridge when the line %s, and stores nothing", async (_why, line) => {
    const f = await fixture();
    create.mockReturnValue(reply(line));
    expect((await farBridges(keyed, env.DB, f.a, [f.next.id], f.items, f.letters, "ja")).size).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM bridges").first<{ n: number }>())!.n).toBe(0);
  });

  it("keeps the fixed bridge without Claude, and for a listener with no own voice", async () => {
    const f = await fixture();
    expect((await farBridges(keyless, env.DB, f.a, [f.next.id], f.items, f.letters, "ja")).size).toBe(0);
    const b = await createListener(env.DB);
    expect((await farBridges(keyed, env.DB, b, [f.next.id], f.items, f.letters, "ja")).size).toBe(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the fixed bridge when Claude errors", async () => {
    const f = await fixture();
    create.mockImplementation(() => {
      throw new Error("down");
    });
    expect((await farBridges(keyed, env.DB, f.a, [f.next.id], f.items, f.letters, "ja")).size).toBe(0);
  });

  it("keeps the fixed bridge when today's bridges are at BRIDGE_DAILY_LIMIT, and 0 pauses", async () => {
    const f = await fixture();
    create.mockReturnValue(reply("あなたの好きな『夜の窓』とは少し違う一冊です。"));
    expect((await farBridges({ ...keyed, BRIDGE_DAILY_LIMIT: "0" } as Env, env.DB, f.a, [f.next.id], f.items, f.letters, "ja")).size).toBe(0);
    expect(create).not.toHaveBeenCalled();
    expect((await farBridges({ ...keyed, BRIDGE_DAILY_LIMIT: "1" } as Env, env.DB, f.a, [f.next.id], f.items, f.letters, "ja")).size).toBe(1);
    const other = await insertItem(env.DB, itemDraft({ title: "別の本", kind: "book" }));
    expect((await farBridges({ ...keyed, BRIDGE_DAILY_LIMIT: "1" } as Env, env.DB, f.a, [other.id], new Map([[other.id, other]]), f.letters, "ja")).size).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reuses the stored line for the same listener and work, without asking again", async () => {
    const f = await fixture();
    create.mockReturnValue(reply("あなたの好きな『夜の窓』とは少し違う一冊です。"));
    const first = await farBridges(keyed, env.DB, f.a, [f.next.id], f.items, f.letters, "ja");
    create.mockReturnValue(reply("『夜の窓』とは別の一冊です。"));
    const second = await farBridges(keyed, env.DB, f.a, [f.next.id], f.items, f.letters, "ja");
    expect(second.get(f.next.id)).toEqual(first.get(f.next.id));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("asks in English for an English programme, and stores it apart", async () => {
    const f = await fixture();
    create.mockReturnValue(reply("A different shade from your beloved '夜の窓'."));
    const bridges = await farBridges(keyed, env.DB, f.a, [f.next.id], f.items, f.letters, "en");
    expect(bridges.get(f.next.id)).toEqual({ type: "dj", text: "A different shade from your beloved '夜の窓'.", bridge: "bridge.far" });
    const req = create.mock.calls[0]![0];
    expect(req.system).toContain("You are the DJ of Dococa FM");
    expect(req.messages[0].content).toContain("Title: 夜の窓");
    expect(req.messages[0].content).toContain("names exactly one of the listener's works");
    const row = await env.DB.prepare("SELECT lang, spoken FROM bridges").first<{ lang: string; spoken: string | null }>();
    expect(row).toEqual({ lang: "en", spoken: null });
  });
});

describe("farBridgeIds", () => {
  const plan = [
    { itemId: "a", slot: "far" as const },
    { itemId: "b", slot: "near" as const },
    { itemId: "c", slot: "far" as const },
  ];
  it("on the listener's own radio, the far works after the opening", () => {
    expect(farBridgeIds(plan, "mine", true)).toEqual(["c"]);
    expect(farBridgeIds(plan, "mine", false)).toEqual(["a", "c"]);
  });
  it("none on world or a public radio: they keep the fixed line", () => {
    expect(farBridgeIds(plan, "world", false)).toEqual([]);
    expect(farBridgeIds(plan, "public", false)).toEqual([]);
  });
});
