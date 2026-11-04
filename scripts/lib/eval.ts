/** Pure parts of `pnpm eval`: argument parsing and the aggregation of episodes read from the admin API. */
import { ja } from "../../src/worker/i18n/ja.ts";
import type { Episode, Item } from "../../src/worker/types.ts";

export type EvalItem = Pick<Item, "title" | "creator">;
export type EvalEpisode = Pick<Episode, "id" | "segments" | "report">;

export const EVAL_USAGE =
  "usage: pnpm eval --listener <listenerId> [--runs 20] [--origin <url>] [--token <ADMIN_TOKEN>] [--out docs/eval/<date>.md]\n       origin defaults to $DOCOCA_ORIGIN, token to $ADMIN_TOKEN";

export type EvalArgs = { origin: string; token: string; listener: string; runs: number; out: string | null };

const VALUE_FLAGS = ["--origin", "--token", "--listener", "--runs", "--out"];

export function parseEvalArgs(argv: string[], env: Record<string, string | undefined> = {}): EvalArgs {
  const value = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (!VALUE_FLAGS.includes(a) || v === undefined || v.startsWith("--")) throw new Error(EVAL_USAGE);
    value.set(a, v);
    i++;
  }
  const listener = value.get("--listener");
  const runs = value.has("--runs") ? Number(value.get("--runs")) : 20;
  if (!listener || !Number.isInteger(runs) || runs < 1 || runs > 100) throw new Error(EVAL_USAGE);
  const token = value.get("--token") ?? env.ADMIN_TOKEN;
  if (!token) throw new Error("ADMIN_TOKEN is not set (use --token or the environment)");
  const origin = (value.get("--origin") ?? env.DOCOCA_ORIGIN ?? "http://127.0.0.1:5173").replace(/\/$/, "");
  return { origin, token, listener, runs, out: value.get("--out") ?? null };
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/** Capitalised words that are not a title or a person: never flagged as unsourced. */
const GENERIC = new Set(["dj", "fm", "ai", "youtube", "spotify", "dococa", "dococa fm", "tmdb", "mcp", "pwa"]);

/** 「…」 and 『…』 spans, then runs of capitalised latin words in what is left (the DJ writes Japanese, so a capital marks a name). */
function namesIn(text: string): string[] {
  const names: string[] = [];
  const rest = text.normalize("NFKC").replace(/[「『]([^」』]+)[」』]/gu, (_, n: string) => {
    names.push(n.trim());
    return " ";
  });
  for (const m of rest.matchAll(/\b[A-Z][\p{L}\p{N}'’.-]*(?:\s+[A-Z][\p{L}\p{N}'’.-]*)*/gu)) names.push(m[0]);
  return names.filter((n) => Array.from(n).length >= 2 && !GENERIC.has(n.toLowerCase()));
}

export type SourcedStats = { sourced: number; checked: number; unsourced: string[] };

/**
 * Of the model-written dj lines that name something (a quoted title or a capitalised latin name), how many
 * name only things that appear in the episode's works (title, creator) or letters (body, radio name, place).
 * Lines without a name are not counted; `fixed` template lines are filled from data and not counted either.
 */
export function sourcedStats(episode: EvalEpisode, items: Record<string, EvalItem>): SourcedStats {
  const pool: string[] = [];
  for (const seg of episode.segments) {
    const item = items[seg.itemId];
    if (item) pool.push(fold(item.title), fold(item.creator));
    for (const line of seg.lines) if (line.type === "letter") pool.push(fold(line.text), fold(line.radioName), fold(line.place));
  }
  const stats: SourcedStats = { sourced: 0, checked: 0, unsourced: [] };
  episode.segments.forEach((seg, si) =>
    seg.lines.forEach((line, li) => {
      if (line.type !== "dj" || line.fixed) return;
      const names = namesIn(line.text);
      if (names.length === 0) return;
      stats.checked++;
      const missing = names.filter((n) => !pool.some((p) => p.includes(fold(n))));
      if (missing.length === 0) stats.sourced++;
      else stats.unsourced.push(`${episode.id}: segment ${si + 1} line ${li + 1}: ${missing.join(", ")}`);
    }),
  );
  return stats;
}

export type Aggregate = {
  runs: number;
  pass: { verbatim: number; sources: number; topical: number; pii: number };
  far: number;
  /** Runs the Worker could not build a verified episode for (it answers 503 and stores nothing). They count as misses on every item. */
  unbuilt: number;
  /** Episodes with no model-written dj line: the fixed-phrase fallback the builder uses when two attempts fail. */
  fallback: number;
  sourced: SourcedStats;
  failures: string[];
};

/** The builder's fixed-phrase episode says 「お便りを読みます。」 in every segment; a model reply that was merely empty does not. */
function isFallback(e: EvalEpisode): boolean {
  return e.segments.length > 0 && e.segments.every((s) => s.lines.some((l) => l.type === "dj" && l.fixed === true && l.text === ja["script.readingOnly"]));
}

export function aggregate(episodes: EvalEpisode[], items: Record<string, EvalItem>, unbuilt = 0): Aggregate {
  const a: Aggregate = { runs: episodes.length + unbuilt, pass: { verbatim: 0, sources: 0, topical: 0, pii: 0 }, far: 0, unbuilt, fallback: 0, sourced: { sourced: 0, checked: 0, unsourced: [] }, failures: [] };
  for (const e of episodes) {
    for (const k of ["verbatim", "sources", "topical", "pii"] as const) if (e.report[k]) a.pass[k]++;
    if (e.segments.some((s) => s.slot === "far")) a.far++;
    if (isFallback(e)) a.fallback++;
    const s = sourcedStats(e, items);
    a.sourced.sourced += s.sourced;
    a.sourced.checked += s.checked;
    a.sourced.unsourced.push(...s.unsourced);
    a.failures.push(...e.report.details.map((d) => `${e.id}: ${d}`));
  }
  return a;
}

const rate = (n: number, total: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);
const row = (label: string, n: number, total: number) => `| ${label} | ${n} / ${total} | ${rate(n, total)} |`;

export function renderMarkdown(a: Aggregate, date: string): string {
  const lines = [
    `# eval ${date}`,
    "",
    `${a.runs} 回の番組づくりを試み、保存された検証レポートと台本を集計した結果です。検証に落ちた番組は保存されないため、作れなかった回（${a.unbuilt} 回）は全項目の未達として数えています。`,
    "",
    "| 項目 | 件数 | 率 |",
    "|---|---|---|",
    row("原文のまま（verbatim）", a.pass.verbatim, a.runs),
    row("出典（sources）", a.pass.sources, a.runs),
    row("時事・数字なし（topical）", a.pass.topical, a.runs),
    row("個人情報・お便りの引用なし（pii）", a.pass.pii, a.runs),
    row("far 枠が 1 つ以上ある回", a.far, a.runs),
    row("定型文だけの回（お便りを読みます。）", a.fallback, a.runs),
    row("名前を挙げた DJ 行のうち、作品かお便りに出所がある行", a.sourced.sourced, a.sourced.checked),
  ];
  if (a.failures.length > 0) lines.push("", "## 検証に落ちた箇所", "", ...a.failures.map((f) => `- ${f}`));
  if (a.sourced.unsourced.length > 0) lines.push("", "## 出所が見つからなかった DJ 行の固有名", "", ...a.sourced.unsourced.map((f) => `- ${f}`));
  return `${lines.join("\n")}\n`;
}
