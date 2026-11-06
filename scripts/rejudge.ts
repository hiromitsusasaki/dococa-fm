/**
 * Judges the stored public letters again with the current moderation (run once after the moderation changes).
 *
 *   pnpm rejudge --origin https://dococafm.app --token "$ADMIN_TOKEN"
 *
 * Env: ADMIN_TOKEN, DOCOCA_ORIGIN (default http://127.0.0.1:5173); pnpm loads .dev.vars for you. Follows
 * `POST /admin/rejudge` page by page until it is done and prints ids, reasons and counts only, never letter
 * text. Safe to run again: a rejected letter is never judged twice, and a letter that could not be judged
 * (counted as skipped) is tried again on the next run. Local only: the Worker never imports this file.
 */
import { parseRejudgeArgs, runRejudge } from "./lib/rejudge.ts";

async function main(): Promise<void> {
  const total = await runRejudge(parseRejudgeArgs(process.argv.slice(2), process.env), fetch, console.log);
  console.log(`done: judged ${total.judged}, rejected ${total.rejected.length}, skipped ${total.skipped}`);
  if (total.skipped > 0) console.log("some letters could not be judged; run the command again to retry them");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error && (e.message.startsWith("usage:") || /^(rejudge failed|cannot reach|ADMIN_TOKEN)/.test(e.message)) ? e.message : `unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  process.exitCode = 1;
});
