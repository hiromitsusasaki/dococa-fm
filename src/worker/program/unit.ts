import { claude, hasClaude, model } from "../claude/client";
import { getUnits, upsertUnit } from "../db/units";
import type { Env } from "../env";
import type { Item, Letter, Segment, Unit } from "../types";
import { letterLines, type UnitLines } from "./compose";
import { DJ_SYSTEM, letterTag, retryNote, workTag } from "./script";
import { verifyEpisode } from "./verify";

export type { UnitLines } from "./compose";

export const INTRO_MAX = 160;
export const AFTER_MAX = 120;
/** Replies out of shape are asked for again, up to this many calls. */
const ATTEMPTS = 3;
/** Checks rephrased lines can fix; verbatim and sources failures come from the data. */
const RETRYABLE = /^(?:topical|measure|pii|announce|playback): /;
/** Units made at once while a programme waits for them. */
const CONCURRENCY = 3;
/** A unit is for everyone, so it is checked against no listener's account. */
const NOBODY = { id: "", mcpToken: "" };

/**
 * Sonnet 5.5 rejects forced tool_choice and strict schemas drop maxLength, so the call is `auto` +
 * `strict`, the limits are stated in words, and `parse` enforces them.
 */
const TOOL = {
  name: "write_unit",
  description: "このお便りの前に言う作品の紹介（intro）と、お便りの後に言う短い感想（after）を返す",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      intro: {
        type: "string",
        description: `作品を紹介する。送り主の名前と土地は言わない（手渡しは別の定型が言う）。お便りの引用も要約もしない。再生や視聴を促す言い方はしない。${INTRO_MAX} 字以内`,
      },
      after: { type: "string", description: `お便りへの短い感想。次のお便りの中身には触れない（つなぎは定型が言う）。${AFTER_MAX} 字以内` },
    },
    required: ["intro", "after"],
    additionalProperties: false,
  },
};

/** One work and one letter; no listener line, since a unit airs in everyone's programme. Japanese only until English units exist. */
function userMessage(input: { item: Item; letter: Letter; retryNotes?: string[] }): string {
  const head = [
    "次のセグメントに、intro と after を書いてください。",
    "お便りと見つけた声は、別の読み上げ役が原文のまま読みます。送り主の名前と土地は、その前に定型文が言います。",
    "あなたは引用も要約もせず、intro で作品を紹介し、after でお便りの内容に短く反応します。",
  ];
  const retry = input.retryNotes?.length ? ["", retryNote(input.retryNotes)] : [];
  const segment = ["<segment>", workTag(input.item), letterTag(input.letter), "</segment>"].join("\n");
  return [...head, ...retry, "", segment].join("\n");
}

const within = (v: unknown, max: number): v is string => typeof v === "string" && Array.from(v).length <= max;

/** The tool's input as unit lines, or null when it is missing or out of shape. */
function parse(content: { type: string; name?: string; input?: unknown }[]): UnitLines | null {
  const block = content.find((b) => b.type === "tool_use" && b.name === TOOL.name);
  const input = block?.input as { intro?: unknown; after?: unknown } | undefined;
  if (!within(input?.intro, INTRO_MAX) || !within(input?.after, AFTER_MAX)) return null;
  return { intro: input.intro, after: input.after };
}

/** One Claude call with the single tool `write_unit` { intro, after }; retried up to 3 times when the reply is out of shape. */
export async function writeUnitLines(env: Env, input: { item: Item; letter: Letter; lang: Unit["lang"]; retryNotes?: string[] }): Promise<UnitLines> {
  const client = claude(env);
  const content = userMessage(input);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const res = await client.messages.create({
      model: model(env),
      max_tokens: 1024,
      system: DJ_SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content }],
    });
    const lines = parse(res.content);
    if (lines) return lines;
  }
  throw new Error("dj unit invalid");
}

/** The one-segment layout a unit is verified and voiced with: [intro?, hand-over(fixed), letter, after?]. No bridges. */
export function unitSegment(unit: UnitLines | null, letter: Letter, item: Item, _lang: Unit["lang"]): Segment {
  return { itemId: item.id, slot: "near", lines: letterLines(letter, unit, true) };
}

function verifyUnit(lines: UnitLines, letter: Letter, item: Item, lang: Unit["lang"]): { ok: boolean; details: string[] } {
  const report = verifyEpisode([unitSegment(lines, letter, item, lang)], new Map([[letter.id, letter]]), NOBODY, new Map([[item.id, item]]));
  return { ok: report.verbatim && report.sources && report.topical && report.pii, details: report.details };
}

/**
 * write → unitSegment → verifyEpisode; one retry with the retryable details; stores verified 0/1. Null when
 * Claude is unavailable (no key, an API error, or replies out of shape): nothing is stored, so a later run makes it.
 */
export async function makeUnit(env: Env, db: D1Database, letter: Letter, item: Item, lang: Unit["lang"]): Promise<Unit | null> {
  if (!hasClaude(env)) return null;
  try {
    let lines = await writeUnitLines(env, { item, letter, lang });
    let check = verifyUnit(lines, letter, item, lang);
    if (!check.ok) {
      console.warn("[dococa] dj unit failed verification", check.details.join("; "));
      const retryNotes = check.details.filter((d) => RETRYABLE.test(d));
      if (retryNotes.length > 0) {
        lines = await writeUnitLines(env, { item, letter, lang, retryNotes });
        check = verifyUnit(lines, letter, item, lang);
        if (!check.ok) console.warn("[dococa] dj unit failed verification again", check.details.join("; "));
      }
    }
    return await upsertUnit(db, { letterId: letter.id, lang, intro: lines.intro, after: lines.after, verified: check.ok, audioReady: false });
  } catch (e) {
    const status = (e as { status?: unknown } | null)?.status;
    console.warn(
      "[dococa] dj unit unavailable; reading the letter with fixed lines",
      typeof status === "number" ? `status ${status}` : "no status",
      e instanceof Error ? e.message : "unknown error",
    );
    return null;
  }
}

/**
 * Stored units for the letters, making the missing ones (concurrency 3) when `hasClaude(env)`. Once Claude
 * turns out unavailable, the rest are not tried in this run. Reactions have no unit and are skipped.
 */
export async function ensureUnits(env: Env, db: D1Database, letters: Letter[], items: ReadonlyMap<string, Item>, lang: Unit["lang"]): Promise<Map<string, Unit>> {
  const units = await getUnits(db, letters.map((l) => l.id), lang);
  const missing = letters.filter((l) => (l.kind === "letter" || l.kind === "found") && !units.has(l.id) && items.has(l.itemId));
  if (missing.length === 0) return units;
  if (!hasClaude(env)) {
    console.warn(`[dococa] ANTHROPIC_API_KEY is empty; ${missing.length} letter(s) read with fixed lines only`);
    return units;
  }
  let unavailable = false;
  let next = 0;
  const worker = async () => {
    while (!unavailable && next < missing.length) {
      const l = missing[next++]!;
      const unit = await makeUnit(env, db, l, items.get(l.itemId)!, lang);
      if (unit) units.set(l.id, unit);
      else unavailable = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  return units;
}
