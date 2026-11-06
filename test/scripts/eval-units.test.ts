import { describe, expect, it, vi } from "vitest";
import { type EvalUnit, type Judge, gradeFromTool, makeJudge, parseEvalUnitsArgs, runEvalUnits, scrubNotes } from "../../scripts/lib/eval-units";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const unit = (i: number, over: Partial<EvalUnit> = {}): EvalUnit => ({
  letterId: `l${String(i).padStart(2, "0")}`,
  lang: "ja",
  title: `作品${i}`,
  letterBody: `お便りの本文その${i}、とても長い秘密の文章です。`,
  intro: `紹介${i}`,
  after: `感想${i}`,
  verified: true,
  liked: false,
});

describe("parseEvalUnitsArgs", () => {
  it("takes the flags, with defaults from the environment", () => {
    expect(parseEvalUnitsArgs(["--origin", "https://x.test/", "--token", "t", "--lang", "en", "--limit", "10", "--remake"], {})).toEqual({
      origin: "https://x.test",
      token: "t",
      lang: "en",
      limit: 10,
      remake: true,
      model: "claude-sonnet-5-5",
    });
    expect(parseEvalUnitsArgs([], { ADMIN_TOKEN: "env", CLAUDE_MODEL: "claude-opus-5-5" })).toEqual({
      origin: "http://127.0.0.1:5173",
      token: "env",
      lang: "ja",
      limit: 40,
      remake: false,
      model: "claude-opus-5-5",
    });
  });

  it("refuses a missing token, a bad language or limit, and unknown flags", () => {
    expect(() => parseEvalUnitsArgs([], {})).toThrow("ADMIN_TOKEN");
    expect(() => parseEvalUnitsArgs(["--lang", "fr"], { ADMIN_TOKEN: "t" })).toThrow("usage:");
    expect(() => parseEvalUnitsArgs(["--limit", "0"], { ADMIN_TOKEN: "t" })).toThrow("usage:");
    expect(() => parseEvalUnitsArgs(["--nope"], { ADMIN_TOKEN: "t" })).toThrow("usage:");
  });
});

describe("gradeFromTool", () => {
  const tool = (input: unknown) => [{ type: "tool_use", name: "grade_unit", input }];
  it("takes an integer score 1-5 and the notes, and nothing else", () => {
    expect(gradeFromTool(tool({ score: 4, notes: "良い" }))).toEqual({ score: 4, notes: "良い" });
    expect(gradeFromTool(tool({ score: 0, notes: "x" }))).toBeNull();
    expect(gradeFromTool(tool({ score: 2.5, notes: "x" }))).toBeNull();
    expect(gradeFromTool(tool({ score: 3 }))).toBeNull();
    expect(gradeFromTool([{ type: "text" }])).toBeNull();
  });
});

describe("scrubNotes", () => {
  it("drops notes that quote the letter, and keeps a note on one line without table pipes", () => {
    expect(scrubNotes("「とても長い秘密の文章」を言い換えている", unit(1).letterBody)).toBe("（お便りの文面を含むため省略）");
    expect(scrubNotes("作品の一点に\n触れている | 良い", unit(1).letterBody)).toBe("作品の一点に 触れている ／ 良い");
  });
});

describe("makeJudge", () => {
  it("asks the model with the one strict grade_unit tool, the rubric, and the unit's texts", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "tool_use", name: "grade_unit", input: { score: 5, notes: "良い" } }] }));
    const judge = makeJudge({ messages: { create } } as never, "claude-opus-5-5");
    expect(await judge.grade(unit(1))).toEqual({ score: 5, notes: "良い" });
    const req = (create.mock.calls[0] as unknown as [any])[0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toMatchObject({ name: "grade_unit", strict: true });
    for (const s of ["作品の具体的な一点に触れる", "煽らない", "ネタバレしない", "お便りの言い換えにしない", "手渡しに自然につながる"]) expect(req.system).toContain(s);
    for (const s of ["作品1", "紹介1", "感想1", "その1"]) expect(req.messages[0].content).toContain(s);
  });
});

describe("runEvalUnits", () => {
  const units = Array.from({ length: 12 }, (_, i) => unit(i + 1));
  const scores: Record<string, number> = Object.fromEntries(units.map((u, i) => [u.letterId, (i % 5) + 1]));
  const judge = (): Judge => ({
    grade: vi.fn(async (u: EvalUnit) => (u.letterId === "l12" ? null : { score: scores[u.letterId]!, notes: u.letterId === "l01" ? `${u.letterBody}をなぞっている` : `メモ ${u.letterId}` })),
    suggest: vi.fn(async () => ["作品の細部を一つ挙げるよう促す"]),
  });

  it("writes the report from the fetched units, with no letter text in the report or the log", async () => {
    const fetchMock = vi.fn(async () => reply({ units, next: null }));
    const files = new Map<string, string>();
    const log = vi.fn();
    const j = judge();
    const out = await runEvalUnits(parseEvalUnitsArgs(["--token", "tok", "--origin", "https://x.test"], {}), {
      fetch: fetchMock as unknown as typeof fetch,
      judge: j,
      log,
      writeFile: async (p, s) => void files.set(p, s),
      now: new Date("2026-11-06T03:00:00Z"),
    });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("https://x.test/admin/units.json?lang=ja&limit=40");
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(out).toEqual({ path: "docs/eval/units-2026-11-06.md", graded: 11, ungraded: 1, low: 5, remade: 0, remakeFailed: 0 });

    const md = files.get("docs/eval/units-2026-11-06.md")!;
    expect(md).toContain("# units 2026-11-06");
    expect(md).toContain("| l02 | 作品2 | 2 |");
    expect(md).toContain("| l12 | 作品12 | — |");
    const lowest = md.slice(md.indexOf("## 低い 10 件"), md.indexOf("## 指示文への提案"));
    expect(lowest.match(/^- /gm)).toHaveLength(10);
    expect(lowest.indexOf("l01")).toBeLessThan(lowest.indexOf("l05"));
    expect(md).toContain("## 指示文への提案");
    expect(md).toContain("- [ ] 作品の細部を一つ挙げるよう促す");
    expect(j.suggest).toHaveBeenCalledWith(expect.not.arrayContaining([expect.stringContaining("秘密")]));
    const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
    for (const text of [md, printed]) {
      expect(text).not.toContain("秘密の文章");
      expect(text).not.toContain("tok");
    }
    expect(printed).not.toContain("紹介");
  });

  it("with --remake posts remake for units scoring 2 or less, by Bearer, without following the redirect", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes("/remake") ? (url.includes("l07") ? reply({}, 409) : new Response(null, { status: 303 })) : reply({ units, next: null })));
    const log = vi.fn();
    const out = await runEvalUnits(parseEvalUnitsArgs(["--token", "tok", "--origin", "https://x.test", "--remake"], {}), {
      fetch: fetchMock as unknown as typeof fetch,
      judge: judge(),
      log,
      writeFile: async () => {},
      now: new Date("2026-11-06T03:00:00Z"),
    });
    const calls = (fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(([u]) => u.includes("/remake"));
    // Scores 1 and 2: l01, l02, l06, l07, l11.
    expect(calls.map(([u]) => u)).toEqual(["l01", "l02", "l06", "l07", "l11"].map((id) => `https://x.test/admin/units/${id}/ja/remake`));
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    }
    expect(out).toMatchObject({ remade: 4, remakeFailed: 1 });
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("秘密");
  });

  it("stops with the status on a failed fetch, never the token", async () => {
    const fetchMock = vi.fn(async () => reply({ error: "unauthorized" }, 401));
    const deps = { fetch: fetchMock as unknown as typeof fetch, judge: judge(), log: () => {}, writeFile: async () => {}, now: new Date() };
    await expect(runEvalUnits(parseEvalUnitsArgs(["--token", "secret"], {}), deps)).rejects.toThrow(/401/);
    await expect(runEvalUnits(parseEvalUnitsArgs(["--token", "secret"], {}), deps)).rejects.not.toThrow(/secret/);
  });
});
