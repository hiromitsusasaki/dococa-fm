/**
 * Grades the DJ's units with Claude and writes docs/eval/units-<date>.md; with --remake, makes the units that
 * scored 2 or less again through the admin page's remake.
 *
 *   pnpm eval:units --origin https://dococafm.app --token "$ADMIN_TOKEN" --lang ja --limit 40 [--remake]
 *
 * Env: ANTHROPIC_API_KEY, ADMIN_TOKEN, DOCOCA_ORIGIN (default http://127.0.0.1:5173), CLAUDE_MODEL (default
 * claude-sonnet-5-5); pnpm loads .dev.vars for you. One Claude call per unit, plus one for the prompt suggestions.
 * Prints counts only, never letter text. Local only: the Worker never imports this file.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { makeJudge, parseEvalUnitsArgs, runEvalUnits } from "./lib/eval-units.ts";

async function main(): Promise<void> {
  const args = parseEvalUnitsArgs(process.argv.slice(2), process.env);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  await runEvalUnits(args, {
    fetch,
    judge: makeJudge(new Anthropic({ apiKey, maxRetries: 2 }), args.model),
    log: console.log,
    writeFile: async (path, text) => {
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await writeFile(path, text);
    },
    now: new Date(),
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error && (e.message.startsWith("usage:") || /^(units fetch failed|cannot reach|ADMIN_TOKEN|ANTHROPIC_API_KEY)/.test(e.message)) ? e.message : `unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  process.exitCode = 1;
});
