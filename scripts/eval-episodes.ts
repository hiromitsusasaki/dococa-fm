/**
 * Makes episodes for one listener through the admin API and totals what the verifier saw.
 *
 *   pnpm eval --listener <listenerId> --runs 20 [--out docs/eval/2026-11-0X.md]
 *
 * Env: ADMIN_TOKEN, DOCOCA_ORIGIN (default http://127.0.0.1:5173); pnpm loads .dev.vars for you. The
 * listener id is shown on /settings. A run calls Claude only for letters whose unit is not made yet (run `POST /admin/prepare` first to make them), and the Worker caps
 * episodes per listener per day (EPISODE_DAILY_LIMIT, default 60; each episode is one segment now).
 * Local only: the Worker never imports this file, and nothing here calls an LLM itself.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { type EvalArgs, type EvalEpisode, type EvalItem, aggregate, parseEvalArgs, renderMarkdown } from "./lib/eval.ts";

class CliError extends Error {}

let args: EvalArgs;

async function admin(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(`${args.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${args.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CliError(`cannot reach ${args.origin} (is pnpm dev or the deployment up?)`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

const fail = (what: string, r: { status: number; json: unknown }): never => {
  throw new CliError(`${what} failed: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
};

async function main(): Promise<void> {
  args = parseEvalArgs(process.argv.slice(2), process.env);
  const episodes: EvalEpisode[] = [];
  const items: Record<string, EvalItem> = {};
  let unbuilt = 0;
  for (let i = 1; i <= args.runs; i++) {
    const made = await admin("POST", "/admin/episodes", { listenerId: args.listener });
    if (made.status === 429) throw new CliError(`daily episode limit reached after ${i - 1} runs; raise EPISODE_DAILY_LIMIT for the eval run`);
    if (made.status === 401) throw new CliError("401 from the admin API: --token / ADMIN_TOKEN does not match the Worker's");
    if (made.status === 404) throw new CliError(`404 from the admin API: listener ${args.listener} not found (the id is on /settings)`);
    if (made.status === 503) {
      unbuilt++;
      console.log(`run ${i}/${args.runs}: not built (503)`);
      continue;
    }
    if (made.status !== 200) fail(`run ${i}: create`, made);
    const got = await admin("GET", `/admin/episodes/${made.json.id}`);
    if (got.status !== 200) fail(`run ${i}: read`, got);
    const episode = got.json as EvalEpisode;
    for (const seg of episode.segments) {
      if (items[seg.itemId]) continue;
      const item = await admin("GET", `/admin/items/${seg.itemId}`);
      if (item.status !== 200) fail(`run ${i}: item ${seg.itemId}`, item);
      items[seg.itemId] = { title: item.json.item.title, creator: item.json.item.creator };
    }
    episodes.push(episode);
    console.log(`run ${i}/${args.runs}: ${episode.id} verbatim=${episode.report.verbatim} sources=${episode.report.sources} topical=${episode.report.topical} pii=${episode.report.pii}`);
  }
  const md = renderMarkdown(aggregate(episodes, items, unbuilt), new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10));
  console.log(`\n${md}`);
  if (args.out) {
    await mkdir(args.out.includes("/") ? args.out.slice(0, args.out.lastIndexOf("/")) : ".", { recursive: true });
    await writeFile(args.out, md);
    console.log(`written: ${args.out}`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof CliError || (e instanceof Error && e.message.startsWith("usage:")) ? (e as Error).message : `unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  process.exitCode = 1;
});
