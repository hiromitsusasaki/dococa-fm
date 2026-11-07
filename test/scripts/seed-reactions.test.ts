import { describe, expect, it } from "vitest";
import type { Persona } from "../../scripts/lib/seed";
import { type Actor, type ListedLetter, checkReply, parseReactionArgs, planReactions, replyPrompt } from "../../scripts/lib/seed-reactions";

const persona = (name: string, lang: "ja" | "en" = "en"): Persona => ({ radioName: name, country: "México", place: "Oaxaca", ageGroup: "40代", taste: "ボレロ", lang });
const actors: Actor[] = Array.from({ length: 6 }, (_, i) => ({ listenerId: `d${i}`, persona: persona(`P${i}`) }));
const letter = (id: string, over: Partial<ListedLetter> = {}): ListedLetter => ({
  id,
  kind: "letter",
  itemId: "i1",
  listenerId: "real1",
  body: "I loved this at 15",
  radioName: "Real",
  demo: false,
  title: "Song",
  creator: "Maker",
  reactorIds: [],
  ...over,
});
const many = Array.from({ length: 60 }, (_, i) => letter(`L${i}`));

describe("planReactions", () => {
  it("never lets a persona react to their own letter or twice to one letter", () => {
    const own = many.map((l, i) => ({ ...l, listenerId: `d${i % 6}` }));
    for (const plan of planReactions(own, actors, 2)) {
      const ids = [...plan.watashimo, ...(plan.reply ? [plan.reply] : [])].map((a) => a.listenerId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(plan.letter.listenerId);
    }
  });

  it("gives 1 to per 私も and at most 1 一言, in total at most 3 people", () => {
    const plans = planReactions(many, actors, 2);
    expect(plans).toHaveLength(60);
    for (const p of plans) {
      expect(p.watashimo.length).toBeGreaterThanOrEqual(1);
      expect(p.watashimo.length).toBeLessThanOrEqual(2);
      expect(p.watashimo.length + (p.reply ? 1 : 0)).toBeLessThanOrEqual(3);
    }
    expect(plans.some((p) => p.reply)).toBe(true);
    expect(plans.some((p) => !p.reply)).toBe(true);
    expect(planReactions(many, actors, 1).every((p) => p.watashimo.length === 1)).toBe(true);
  });

  it("is idempotent: a letter with a demo reaction gets nothing, a real listener's reaction does not count", () => {
    expect(planReactions([letter("A", { reactorIds: ["d3"] })], actors, 2)).toEqual([]);
    expect(planReactions([letter("A", { reactorIds: ["someone-real"] })], actors, 2)).toHaveLength(1);
    const first = planReactions(many, actors, 2);
    const again = planReactions(
      many.map((l) => ({ ...l, reactorIds: first.find((p) => p.letter.id === l.id)!.watashimo.map((a) => a.listenerId) })),
      actors,
      2,
    );
    expect(again).toEqual([]);
  });

  it("draws the same people on every run", () => {
    expect(planReactions(many, actors, 2).map((p) => p.watashimo.map((a) => a.listenerId))).toEqual(planReactions(many, actors, 2).map((p) => p.watashimo.map((a) => a.listenerId)));
  });
});

describe("checkReply", () => {
  it("accepts a plain line and keeps the work's creator allowed", () => {
    expect(checkReply({ text: "Same here, it takes me right back." }, persona("a"), "Maker").ok).toBe(true);
  });
  it("refuses over 120 characters, numbers about works, contact text, topical words, and a wrong script", () => {
    expect(checkReply({ text: "a".repeat(121) }, persona("a"), "x")).toEqual({ ok: false, reason: "too long" });
    expect(checkReply({ text: "It was number one for me." }, persona("a"), "x").ok).toBe(false);
    expect(checkReply({ text: "Write me at me@example.com" }, persona("a"), "x").ok).toBe(false);
    expect(checkReply({ text: "最近ずっと聴いてます" }, persona("a", "ja"), "x").ok).toBe(false);
    expect(checkReply({ text: "ありがとう" }, persona("a"), "x").ok).toBe(false);
    expect(checkReply({ text: "Taylor Swift would agree." }, persona("a"), "x").ok).toBe(false);
    expect(checkReply(null, persona("a"), "x").ok).toBe(false);
  });
});

describe("arguments and prompt", () => {
  it("reads flags and the environment", () => {
    expect(parseReactionArgs(["--origin", "https://x.test/", "--per", "1", "--letters", "a, b", "--dry-run"], { ADMIN_TOKEN: "t" })).toEqual({ origin: "https://x.test", token: "t", letters: ["a", "b"], per: 1, dryRun: true });
    expect(parseReactionArgs([], { ADMIN_TOKEN: "t", DOCOCA_ORIGIN: "https://y.test" })).toMatchObject({ origin: "https://y.test", per: 2, letters: null, dryRun: false });
  });
  it("refuses a bad --per, a missing value and a missing token", () => {
    expect(() => parseReactionArgs(["--per", "3"], { ADMIN_TOKEN: "t" })).toThrow(/usage/);
    expect(() => parseReactionArgs(["--origin"], { ADMIN_TOKEN: "t" })).toThrow(/usage/);
    expect(() => parseReactionArgs([], {})).toThrow(/ADMIN_TOKEN/);
  });
  it("puts the letter in as quoted material", () => {
    expect(replyPrompt(persona("P0"), letter("L"))).toContain("<letter>\nI loved this at 15\n</letter>");
  });
});
