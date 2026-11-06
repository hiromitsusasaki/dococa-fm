/**
 * Pure parts of `pnpm eval:units`: arguments, the grader's prompt and tool, the report, and the loop over
 * `GET /admin/units.json` (and `POST .../remake` with `--remake`). Letter text goes to the grader only: the
 * report and the log carry ids, work titles, scores and the grader's notes (a note that quotes the letter is dropped).
 */
import type Anthropic from "@anthropic-ai/sdk";

export const EVAL_UNITS_USAGE =
  "usage: pnpm eval:units [--origin <url>] [--token <ADMIN_TOKEN>] [--lang ja|en] [--limit 40] [--remake]\n       origin defaults to $DOCOCA_ORIGIN, token to $ADMIN_TOKEN, the model to $CLAUDE_MODEL";

export type EvalUnitsArgs = { origin: string; token: string; lang: "ja" | "en"; limit: number; remake: boolean; model: string };

/** One row of `/admin/units.json`, as far as the grader needs it. */
export type EvalUnit = { letterId: string; lang: "ja" | "en"; title: string; letterBody: string; intro: string; after: string; verified: boolean; liked: boolean };
export type Grade = { score: number; notes: string };
export type Judge = { grade(unit: EvalUnit): Promise<Grade | null>; suggest(notes: string[]): Promise<string[]> };

/** Units scoring this or less are made again with `--remake`. */
export const REMAKE_AT_OR_BELOW = 2;
/** Notes of units scoring this or less go to the prompt suggestions. */
const SUGGEST_AT_OR_BELOW = 3;
const LOWEST = 10;
const MAX_LIMIT = 100;

export function parseEvalUnitsArgs(argv: string[], env: Record<string, string | undefined> = {}): EvalUnitsArgs {
  const value = new Map<string, string>();
  let remake = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--remake") {
      remake = true;
      continue;
    }
    const v = argv[i + 1];
    if (!["--origin", "--token", "--lang", "--limit"].includes(a) || v === undefined || v.startsWith("--")) throw new Error(EVAL_UNITS_USAGE);
    value.set(a, v);
    i++;
  }
  const lang = value.get("--lang") ?? "ja";
  const limit = value.has("--limit") ? Number(value.get("--limit")) : 40;
  if ((lang !== "ja" && lang !== "en") || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(EVAL_UNITS_USAGE);
  const token = value.get("--token") ?? env.ADMIN_TOKEN;
  if (!token) throw new Error("ADMIN_TOKEN is not set (use --token or the environment)");
  const origin = (value.get("--origin") ?? env.DOCOCA_ORIGIN ?? "http://127.0.0.1:5173").replace(/\/$/, "");
  return { origin, token, lang, limit, remake, model: env.CLAUDE_MODEL || "claude-sonnet-5-5" };
}

const RUBRIC = [
  "1. 作品の具体的な一点に触れる（どの作品にも言える褒め言葉で済ませない）",
  "2. 煽らない（大げさな形容、断定的な称賛、聴取や視聴を促す言い方をしない）",
  "3. ネタバレしない（結末や仕掛けを明かさない）",
  "4. お便りの言い換えにしない（intro がお便りの中身を先取りしたり要約したりしない）",
  "5. 手渡しに自然につながる（intro のあとに送り主の名前と土地を言う定型文、その後にお便りの朗読が続く）",
];

export const GRADE_SYSTEM = [
  "あなたはラジオ番組の台本の採点者です。DJ がお便り 1 通の前に言う作品紹介（intro）と、お便りの後に言う短い感想（after）を、次の基準で採点します。",
  ...RUBRIC,
  "score は 1〜5 の整数（5 = すべて満たす、1 = ほとんど満たさない）。notes は日本語 120 字以内で、満たしていない基準の番号と理由を書く。お便りの文面は notes に引用しない。",
  "必ず grade_unit ツールを 1 回だけ呼んで答える。ほかの文章は書かない。",
].join("\n");

const GRADE_TOOL = {
  name: "grade_unit",
  description: "単位（intro と after）の採点を返す",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      score: { type: "integer", description: "1〜5 の整数" },
      notes: { type: "string", description: "満たしていない基準の番号と理由。120 字以内。お便りの文面は引用しない" },
    },
    required: ["score", "notes"],
    additionalProperties: false,
  },
};

const SUGGEST_TOOL = {
  name: "suggest_prompt",
  description: "DJ の指示文への改善提案を返す",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: { suggestions: { type: "array", items: { type: "string" }, description: "指示文に足す・直す一文ずつ。5 件まで" } },
    required: ["suggestions"],
    additionalProperties: false,
  },
};

const SUGGEST_SYSTEM = [
  "あなたはラジオ番組の DJ 台本を書くモデルへの指示文を直す編集者です。採点者のメモ（低い点の理由）を読み、指示文に足す・直す一文を提案します。",
  "提案は一般的な書き方の指示にし、特定の作品やお便りの中身を書かない。時事や数字で人や作品を測る指示は出さない。5 件まで。",
  "必ず suggest_prompt ツールを 1 回だけ呼んで答える。ほかの文章は書かない。",
].join("\n");

/** Tags in a text cannot close or open the prompt's own tags. */
const tagSafe = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The tool's input as a grade, or null when it is missing or out of shape. */
export function gradeFromTool(content: { type: string; name?: string; input?: unknown }[]): Grade | null {
  const input = content.find((b) => b.type === "tool_use" && b.name === GRADE_TOOL.name)?.input as { score?: unknown; notes?: unknown } | undefined;
  const score = input?.score;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5 || typeof input?.notes !== "string") return null;
  return { score, notes: input.notes };
}

/** The grader on the Messages API: one strict tool with `tool_choice: auto` (Sonnet 5.5 rejects a forced choice). */
export function makeJudge(client: Pick<Anthropic, "messages">, model: string): Judge {
  return {
    async grade(u) {
      const user = [
        `<work>${tagSafe(u.title)}</work>`,
        `<letter>${tagSafe(u.letterBody)}</letter>`,
        `<intro>${tagSafe(u.intro)}</intro>`,
        `<after>${tagSafe(u.after)}</after>`,
      ].join("\n");
      const res = await client.messages.create({
        model,
        max_tokens: 512,
        system: GRADE_SYSTEM,
        tools: [GRADE_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: user }],
      });
      return gradeFromTool(res.content as { type: string; name?: string; input?: unknown }[]);
    },
    async suggest(notes) {
      if (notes.length === 0) return [];
      const res = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SUGGEST_SYSTEM,
        tools: [SUGGEST_TOOL],
        tool_choice: { type: "auto" },
        messages: [{ role: "user", content: notes.map((n) => `- ${tagSafe(n)}`).join("\n") }],
      });
      const input = (res.content as { type: string; name?: string; input?: unknown }[]).find((b) => b.type === "tool_use" && b.name === SUGGEST_TOOL.name)?.input as { suggestions?: unknown } | undefined;
      return Array.isArray(input?.suggestions) ? input.suggestions.filter((s): s is string => typeof s === "string").slice(0, 5) : [];
    },
  };
}

const fold = (s: string) => s.normalize("NFKC").replace(/\s+/gu, "");
/** A run of this many code points shared with the letter counts as quoting it. */
const QUOTE_RUN = 8;

/**
 * The grader's note as the report prints it: on one line, `|` swapped so it cannot break a table, and dropped
 * whole when it carries a run of the letter's text, or the whole letter when it is shorter than the run (the report is
 * committed; the letter is not ours to publish).
 */
export function scrubNotes(notes: string, letterBody: string): string {
  const body = Array.from(fold(letterBody));
  const folded = fold(notes);
  // A letter shorter than the run is matched whole.
  const run = Math.min(QUOTE_RUN, body.length);
  if (run > 0) for (let i = 0; i + run <= body.length; i++) if (folded.includes(body.slice(i, i + run).join(""))) return "（お便りの文面を含むため省略）";
  return oneCell(notes);
}

const oneCell = (s: string) => s.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/gu, " ").replace(/\|/g, "／").trim();

type Graded = { unit: EvalUnit; grade: Grade | null };

export function renderUnitsReport(graded: Graded[], suggestions: string[], date: string, lang: "ja" | "en"): string {
  const scored = graded.filter((g): g is { unit: EvalUnit; grade: Grade } => g.grade !== null);
  const counts = [5, 4, 3, 2, 1].map((s) => `| ${s} | ${scored.filter((g) => g.grade.score === s).length} |`);
  const lowest = [...scored].sort((a, b) => a.grade.score - b.grade.score || (a.unit.letterId < b.unit.letterId ? -1 : 1)).slice(0, LOWEST);
  const lines = [
    `# units ${date}`,
    "",
    `言語 ${lang} の単位 ${graded.length} 件を Claude に採点させた結果です（採点できなかったもの ${graded.length - scored.length} 件）。基準は ${RUBRIC.length} つ（docs/eval/units.md）。点数は単位の見直しのためのもので、作品やお便りを測るものではありません。`,
    "",
    "| 点 | 件数 |",
    "|---|---|",
    ...counts,
    "",
    "## 全件",
    "",
    "| お便り ID | 作品 | 点 |",
    "|---|---|---|",
    ...graded.map((g) => `| ${g.unit.letterId} | ${oneCell(g.unit.title)} | ${g.grade ? g.grade.score : "—"} |`),
    "",
    `## 低い ${LOWEST} 件`,
    "",
    ...(lowest.length === 0 ? ["（なし）"] : lowest.map((g) => `- ${g.unit.letterId}（${oneCell(g.unit.title)}）: ${g.grade.score} — ${scrubNotes(g.grade.notes, g.unit.letterBody)}`)),
    "",
    "## 指示文への提案",
    "",
    "本人が読んで、採るものに印を付けてから指示文（src/worker/program/unit.ts）に反映します。自動では反映しません。",
    "",
    ...(suggestions.length === 0 ? ["（なし）"] : suggestions.map((s) => `- [ ] ${oneCell(s)}`)),
  ];
  return `${lines.join("\n")}\n`;
}

export type EvalUnitsDeps = {
  fetch: typeof fetch;
  judge: Judge;
  log: (line: string) => void;
  writeFile: (path: string, text: string) => Promise<void>;
  now: Date;
};

export type EvalUnitsResult = { path: string; graded: number; ungraded: number; low: number; remade: number; remakeFailed: number };

/** Fetches the units, grades them one by one, writes the report, and with `--remake` makes the low ones again. Counts only in the log. */
export async function runEvalUnits(args: EvalUnitsArgs, deps: EvalUnitsDeps): Promise<EvalUnitsResult> {
  const auth = { authorization: `Bearer ${args.token}` };
  let res: Response;
  try {
    res = await deps.fetch(`${args.origin}/admin/units.json?lang=${args.lang}&limit=${args.limit}`, { headers: auth });
  } catch {
    throw new Error(`cannot reach ${args.origin} (is pnpm dev or the deployment up?)`);
  }
  const body = (await res.json().catch(() => null)) as { units?: EvalUnit[] } | null;
  if (res.status !== 200 || !Array.isArray(body?.units)) throw new Error(`units fetch failed: ${res.status}`);

  const graded: Graded[] = [];
  for (const [i, unit] of body.units.entries()) {
    let grade: Grade | null = null;
    try {
      grade = await deps.judge.grade(unit);
    } catch {
      grade = null;
    }
    graded.push({ unit, grade });
    deps.log(`graded ${i + 1}/${body.units.length}`);
  }
  const lowNotes = graded.flatMap((g) => (g.grade && g.grade.score <= SUGGEST_AT_OR_BELOW ? [scrubNotes(g.grade.notes, g.unit.letterBody)] : []));
  const suggestions = await deps.judge.suggest(lowNotes).catch(() => []);
  const date = new Date(deps.now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const path = `docs/eval/units-${date}.md`;
  await deps.writeFile(path, renderUnitsReport(graded, suggestions, date, args.lang));

  const low = graded.filter((g) => g.grade && g.grade.score <= REMAKE_AT_OR_BELOW);
  let remade = 0;
  let remakeFailed = 0;
  if (args.remake) {
    for (const g of low) {
      try {
        const r = await deps.fetch(`${args.origin}/admin/units/${encodeURIComponent(g.unit.letterId)}/${args.lang}/remake`, { method: "POST", headers: auth, redirect: "manual" });
        if (r.status === 303) remade++;
        else remakeFailed++;
      } catch {
        remakeFailed++;
      }
    }
  }
  const out = { path, graded: graded.length - graded.filter((g) => !g.grade).length, ungraded: graded.filter((g) => !g.grade).length, low: low.length, remade, remakeFailed };
  deps.log(`graded ${out.graded}, ungraded ${out.ungraded}, scored ${REMAKE_AT_OR_BELOW} or less ${out.low}${args.remake ? `, remade ${remade}, remake failed ${remakeFailed}` : ""}`);
  deps.log(`written: ${path}`);
  return out;
}
