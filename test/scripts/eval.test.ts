import { describe, expect, it } from "vitest";
import {
  type EvalEpisode,
  type EvalItem,
  EVAL_USAGE,
  aggregate,
  parseEvalArgs,
  renderMarkdown,
  sourcedStats,
} from "../../scripts/lib/eval";

const items: Record<string, EvalItem> = { i1: { title: "Blue in Green", creator: "Miles Davis" }, i2: { title: "秒速5センチメートル", creator: "新海誠" } };

const letter = (over: Record<string, unknown> = {}) => ({
  type: "letter" as const,
  letterId: "l1",
  text: "雨の日に聴いています。",
  radioName: "ミナミ",
  place: "那覇",
  kind: "letter" as const,
  sourceUrl: null,
  sourceAuthor: null,
  ...over,
});

const episode = (over: Partial<EvalEpisode> = {}): EvalEpisode => ({
  id: "e1",
  segments: [
    { itemId: "i1", slot: "near", lines: [{ type: "dj", text: "続いては「Blue in Green」。" }, letter()] },
    { itemId: "i2", slot: "far", lines: [{ type: "dj", text: "遠い国から、新海誠の一本です。" }] },
  ],
  report: { verbatim: true, sources: true, topical: true, pii: true, details: [] },
  ...over,
});

describe("sourcedStats", () => {
  it("counts a dj line whose names all appear in the items or letters as sourced", () => {
    expect(sourcedStats(episode(), items)).toEqual({ sourced: 1, checked: 1, unsourced: [] });
  });

  it("flags a quoted name that is in no item and no letter", () => {
    const e = episode();
    e.segments[0]!.lines.push({ type: "dj", text: "次は「Kind of Blue」です。" });
    const r = sourcedStats(e, items);
    expect(r).toMatchObject({ sourced: 1, checked: 2 });
    expect(r.unsourced).toEqual(["e1: segment 1 line 3: Kind of Blue"]);
  });

  it("flags a capitalised latin name that is nowhere in the material", () => {
    const e = episode();
    e.segments[1]!.lines.push({ type: "dj", text: "そういえば Coltrane も好きでした。" });
    expect(sourcedStats(e, items).unsourced).toEqual(["e1: segment 2 line 2: Coltrane"]);
  });

  it("matches case-insensitively and accepts names from letters (radio name, place)", () => {
    const e = episode();
    e.segments[0]!.lines.push({ type: "dj", text: "「blue in green」を、那覇のミナミさんから。" });
    expect(sourcedStats(e, items).unsourced).toEqual([]);
  });

  it("does not flag generic words or one-letter tokens", () => {
    const e = episode();
    e.segments[0]!.lines.push({ type: "dj", text: "DJ の YouTube 好きな A 面。" });
    expect(sourcedStats(e, items).unsourced).toEqual([]);
  });

  it("skips fixed template lines and lines without any name", () => {
    const e = episode();
    e.segments[0]!.lines.push({ type: "dj", text: "「Kind of Blue」", fixed: true }, { type: "dj", text: "ここで一息。" });
    expect(sourcedStats(e, items)).toMatchObject({ checked: 1 });
  });
});

describe("aggregate", () => {
  it("is 100% on all items when every episode passes and has a far segment", () => {
    const a = aggregate([episode(), episode({ id: "e2" })], items);
    expect(a.runs).toBe(2);
    expect(a.pass).toEqual({ verbatim: 2, sources: 2, topical: 2, pii: 2 });
    expect(a.far).toBe(2);
    expect(a.sourced).toEqual({ sourced: 2, checked: 2, unsourced: [] });
    expect(a.failures).toEqual([]);
  });

  it("counts failures per item and lists the details of failing episodes", () => {
    const bad = episode({ id: "e2", report: { verbatim: false, sources: true, topical: true, pii: false, details: ["verbatim: segment 1 line 2: differs"] } });
    bad.segments = bad.segments.filter((s) => s.slot !== "far");
    const a = aggregate([episode(), bad], items);
    expect(a.pass).toEqual({ verbatim: 1, sources: 2, topical: 2, pii: 1 });
    expect(a.far).toBe(1);
    expect(a.failures).toEqual(["e2: verbatim: segment 1 line 2: differs"]);
  });

  it("counts unbuilt runs as misses on every item and detects the fixed-phrase fallback", () => {
    const fixedOnly = episode({ id: "e2" });
    fixedOnly.segments = [{ itemId: "i1", slot: "far", lines: [{ type: "dj", text: "お便りを読みます。", fixed: true }] }];
    const a = aggregate([episode(), fixedOnly], items, 2);
    expect(a.runs).toBe(4);
    expect(a.pass.verbatim).toBe(2);
    expect(a.far).toBe(2);
    expect(a.fallback).toBe(1);
    expect(a.unbuilt).toBe(2);
    expect(renderMarkdown(a, "2026-11-05")).toContain("| 原文のまま（verbatim） | 2 / 4 | 50% |");
  });

  it("does not call an episode with an empty model reply a fallback", () => {
    const emptyReply = episode({ id: "e3" });
    emptyReply.segments = [{ itemId: "i1", slot: "far", lines: [{ type: "dj", text: "声の主は、どこかの誰か。", fixed: true }, letter()] }];
    expect(aggregate([emptyReply], items).fallback).toBe(0);
  });

  it("handles zero runs without dividing by zero", () => {
    expect(renderMarkdown(aggregate([], items), "2026-11-05")).toContain("0 回");
  });
});

describe("renderMarkdown", () => {
  it("shows rates and counts, and reports a rule miss plainly", () => {
    const bad = episode({ id: "e2", report: { verbatim: false, sources: true, topical: true, pii: true, details: ["verbatim: x"] } });
    const md = renderMarkdown(aggregate([episode(), bad], items), "2026-11-05");
    expect(md).toContain("# eval 2026-11-05");
    expect(md).toContain("| 原文のまま（verbatim） | 1 / 2 | 50% |");
    expect(md).toContain("| far 枠が 1 つ以上ある回 | 2 / 2 | 100% |");
    expect(md).toContain("e2: verbatim: x");
  });
});

describe("parseEvalArgs", () => {
  it("reads flags and falls back to the environment", () => {
    const a = parseEvalArgs(["--listener", "L1", "--runs", "5", "--out", "docs/eval/x.md"], { ADMIN_TOKEN: "t", DOCOCA_ORIGIN: "https://x.example/" });
    expect(a).toEqual({ origin: "https://x.example", token: "t", listener: "L1", runs: 5, out: "docs/eval/x.md" });
  });

  it("defaults to 20 runs and local origin, and requires a listener and a token", () => {
    expect(parseEvalArgs(["--listener", "L", "--token", "t"], {})).toMatchObject({ runs: 20, origin: "http://127.0.0.1:5173", out: null });
    expect(() => parseEvalArgs(["--token", "t"], {})).toThrow(EVAL_USAGE);
    expect(() => parseEvalArgs(["--listener", "L"], {})).toThrow("ADMIN_TOKEN");
    expect(() => parseEvalArgs(["--listener", "L", "--token", "t", "--runs", "0"], {})).toThrow(EVAL_USAGE);
    expect(() => parseEvalArgs(["--listener", "L", "--token", "t", "--bogus", "1"], {})).toThrow(EVAL_USAGE);
  });
});
