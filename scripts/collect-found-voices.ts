/**
 * Collects "voices found on the net" for one item and posts them through the admin API.
 *
 *   pnpm collect --item <itemId | url>   dry run: writes .found/<itemId>.json and posts nothing
 *   pnpm collect --post <file>           posts a file you have reviewed (delete lines you do not want first)
 *
 * Env: YOUTUBE_API_KEY, ADMIN_TOKEN, DOCOCA_ORIGIN (default http://127.0.0.1:5173), and the
 * Claude credentials the Agent SDK uses (ANTHROPIC_API_KEY or a Claude Code login).
 * pnpm loads .dev.vars for you. Local only: the Worker never imports this file.
 *
 * What the AI does not do is built into the shape of the flow. Claude receives the candidate comments
 * and may answer only with ids. The text that is posted is the original of each picked id, taken
 * from this script's own list, so Claude has no path to change a word. Claude can still pick a
 * comment you would not, so a person reads the file before anything is posted.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type Candidate, type FoundBody, SELECTION_SYSTEM, candidatesFromThreads, parseArgs, parseFoundFile, parseSelection, selectionPrompt, voicesFor } from "./lib/found.ts";

const YOUTUBE = "https://www.googleapis.com/youtube/v3";
const VIDEOS = 3;
const COMMENTS_PER_VIDEO = 100;

type ItemInfo = { id: string; title: string; creator: string };

class CliError extends Error {}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new CliError(`${name} is not set`);
  return v;
}

const origin = (): string => (process.env.DOCOCA_ORIGIN ?? "http://127.0.0.1:5173").replace(/\/$/, "");

/** Calls the admin API. Error text carries the status and the API's own message, never the token. */
async function admin<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${origin()}${path}`, {
    method,
    headers: { authorization: `Bearer ${need("ADMIN_TOKEN")}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new CliError(`${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function resolveItem(arg: string): Promise<ItemInfo> {
  const { item } = /^https?:\/\//.test(arg)
    ? await admin<{ item: ItemInfo }>("POST", "/admin/items", { url: arg })
    : await admin<{ item: ItemInfo }>("GET", `/admin/items/${encodeURIComponent(arg)}`);
  return item;
}

/** The key rides in the query string, so failures report only the endpoint and status. */
async function youtube<T>(endpoint: string, params: Record<string, string>): Promise<T | null> {
  const url = `${YOUTUBE}/${endpoint}?${new URLSearchParams({ ...params, key: need("YOUTUBE_API_KEY") })}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`youtube ${endpoint}: ${res.status}${res.status === 403 ? " (quota or comments disabled)" : ""}`);
    return null;
  }
  return (await res.json()) as T;
}

async function collectCandidates(item: ItemInfo): Promise<Candidate[]> {
  const found = await youtube<{ items?: Array<{ id?: { videoId?: string } }> }>("search", {
    part: "snippet",
    q: `${item.title} ${item.creator}`.trim(),
    type: "video",
    maxResults: String(VIDEOS),
  });
  const videoIds = (found?.items ?? []).flatMap((v) => (v.id?.videoId ? [v.id.videoId] : []));
  const all: Candidate[] = [];
  for (const videoId of videoIds) {
    const threads = await youtube<{ items?: Parameters<typeof candidatesFromThreads>[1] }>("commentThreads", {
      part: "snippet",
      videoId,
      maxResults: String(COMMENTS_PER_VIDEO),
      order: "relevance",
    });
    all.push(...candidatesFromThreads(videoId, threads?.items ?? []));
  }
  return all;
}

/**
 * Asks Claude for ids only. No tool is offered (`tools: []`, `allowedTools: []`) and a PreToolUse hook
 * denies any call anyway, so the model can read the comments and nothing else.
 */
async function askForIds(item: ItemInfo, candidates: Candidate[]): Promise<{ ids: string[]; deniedCalls: number }> {
  let deniedCalls = 0;
  let answer = "";
  for await (const message of query({
    prompt: selectionPrompt(item.title, item.creator, candidates),
    options: {
      systemPrompt: SELECTION_SYSTEM,
      tools: [],
      allowedTools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 2,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async () => {
                deniedCalls += 1;
                return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "この作業では道具を使えません" } };
              },
            ],
          },
        ],
      },
    },
  })) {
    if (message.type === "result") {
      if (message.subtype !== "success") throw new CliError(`claude did not finish: ${message.subtype}`);
      answer = message.result;
    }
  }
  return { ids: parseSelection(answer, candidates), deniedCalls };
}

const FOUND_DIR = ".found";

async function collect(arg: string): Promise<void> {
  const item = await resolveItem(arg);
  console.log(`item: ${item.title} / ${item.creator} (${item.id})`);

  const candidates = await collectCandidates(item);
  console.log(`candidates (100 characters or fewer, with author): ${candidates.length}`);
  if (candidates.length === 0) return;

  const { ids, deniedCalls } = await askForIds(item, candidates);
  const voices = voicesFor(ids, candidates);
  console.log(`picked: ${voices.length}, tool calls denied: ${deniedCalls}`);
  for (const v of voices) console.log(`- ${v.author}: ${v.body.replace(/\n/g, " ")}\n  ${v.url}`);
  if (voices.length === 0) return;

  const file = `${FOUND_DIR}/${item.id}.json`;
  const body: FoundBody = { itemId: item.id, voices };
  await mkdir(FOUND_DIR, { recursive: true });
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${file}. Read it, delete what you do not want, then: pnpm collect --post ${file}`);
}

async function post(file: string): Promise<void> {
  const body = parseFoundFile(await readFile(file, "utf8"));
  const res = await admin<{ letterIds: string[]; skipped: string[]; rejected: Array<{ index: number; url: string; reason: string }> }>("POST", "/admin/found", body);
  console.log(`posted: ${res.letterIds.length}, already there: ${res.skipped.length}, turned down by moderation: ${res.rejected.length}`);
  for (const r of res.rejected) console.log(`- rejected (${r.reason}): ${r.url}`);
  console.log(`${origin()}/items/${body.itemId}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await (args.mode === "collect" ? collect(args.item) : post(args.file));
}

main().catch((e: unknown) => {
  console.error(e instanceof CliError || (e instanceof Error && e.message.startsWith("usage:")) ? (e as Error).message : `unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  process.exitCode = 1;
});
