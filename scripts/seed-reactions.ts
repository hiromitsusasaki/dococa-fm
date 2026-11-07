/**
 * Makes the demo personas react to public letters: 私も from one or two of them and, on about half the letters,
 * a short 一言 written by Claude in the persona's own voice. Reactions by a demo account carry the デモ用 mark
 * because the mark follows the listener. Idempotent: a letter that a demo persona has reacted to is left alone,
 * so it can be run again later for letters people posted after the first run.
 *
 *   pnpm seed:reactions --origin https://dococafm.app            react to every letter that has none
 *   pnpm seed:reactions --letters <id,...>                       only these letters (the ids GET /admin/letters.json lists)
 *   pnpm seed:reactions --dry-run                                 write the 一言 and print the plan; post nothing
 *
 * Env: ANTHROPIC_API_KEY, ADMIN_TOKEN, DOCOCA_ORIGIN (default http://127.0.0.1:5173); pnpm loads .dev.vars.
 * Personas come from docs/demo/personas.json and are matched to the server's demo listeners by radio name.
 * A 一言 that breaks a rule is skipped after one more try; nothing is edited. The token is never printed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { MODEL, parsePersonas } from "./lib/seed.ts";
import { type Actor, type ListedLetter, type Plan, REPLY_SYSTEM, REPLY_TOOL, checkReply, parseReactionArgs, planReactions, replyPrompt } from "./lib/seed-reactions.ts";

const PERSONAS_FILE = "docs/demo/personas.json";
const PAGE = 100;

class CliError extends Error {}

let args: ReturnType<typeof parseReactionArgs>;

async function admin(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${args.origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${args.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

async function loadActors(): Promise<Actor[]> {
  const { personas } = parsePersonas(JSON.parse(await readFile(PERSONAS_FILE, "utf8")));
  const r = await admin("GET", "/admin/listeners.json");
  if (r.status !== 200) return fail("GET /admin/listeners.json", r);
  const byName = new Map<string, string>((r.json.listeners as { id: string; radioName: string }[]).map((l) => [l.radioName, l.id]));
  const actors = personas.flatMap((persona) => {
    const listenerId = byName.get(persona.radioName);
    return listenerId ? [{ listenerId, persona }] : [];
  });
  if (actors.length < 2) throw new CliError(`only ${actors.length} personas of ${PERSONAS_FILE} exist as demo listeners on ${args.origin}`);
  return actors;
}

async function loadLetters(): Promise<ListedLetter[]> {
  const letters: ListedLetter[] = [];
  for (let after: string | null = null, pages = 0; pages < 1000; pages++) {
    const r = await admin("GET", `/admin/letters.json?limit=${PAGE}${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (r.status !== 200) return fail("GET /admin/letters.json", r);
    letters.push(...(r.json.letters as ListedLetter[]));
    after = r.json.next as string | null;
    if (after === null) break;
  }
  return args.letters ? letters.filter((l) => args.letters!.includes(l.id)) : letters;
}

/** One call, one strict tool, `tool_choice: auto` (Sonnet 5.5 rejects a forced choice); the text, or null unless exactly one call came back. */
async function writeReply(client: Anthropic, actor: Actor, letter: ListedLetter): Promise<unknown> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: `${REPLY_SYSTEM}\n必ず ${REPLY_TOOL.name} ツールを 1 回だけ呼んで答える。ほかの文章は書かない。`,
    tools: [{ ...REPLY_TOOL, strict: true }],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: replyPrompt(actor.persona, letter) }],
  });
  const calls = res.content.filter((b) => b.type === "tool_use" && b.name === REPLY_TOOL.name);
  const [only] = calls;
  return calls.length === 1 && only?.type === "tool_use" ? only.input : null;
}

/** A 一言 that passes the checks, or null after the first try and one more. */
async function replyText(client: Anthropic, actor: Actor, letter: ListedLetter): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: unknown;
    try {
      raw = await writeReply(client, actor, letter);
    } catch (e) {
      console.warn(`  reply not written for ${letter.id} (${e instanceof Error ? e.name : "error"})`);
      continue;
    }
    const verdict = checkReply(raw, actor.persona, letter.creator);
    if (verdict.ok) return (raw as { text: string }).text;
    console.warn(`  reply dropped for ${letter.id} by ${actor.persona.radioName}: ${verdict.reason}`);
  }
  return null;
}

const total = { reacted: 0, watashimo: 0, replies: 0, skipped: 0 };

async function post(plan: Plan, actor: Actor, kind: "watashimo" | "reply", body?: string): Promise<boolean> {
  const r = await admin("POST", "/admin/letters", { listenerId: actor.listenerId, itemId: plan.letter.itemId, kind, parentLetterId: plan.letter.id, ...(body === undefined ? {} : { body }) });
  if (r.status === 200) return true;
  // The id and the answer's error key only: a letter's text never goes to the log.
  console.warn(`  not posted (${r.status} ${r.json?.error ?? "?"}): ${kind} by ${actor.persona.radioName} on ${plan.letter.id}`);
  return false;
}

async function react(client: Anthropic, plan: Plan): Promise<void> {
  let did = 0;
  for (const actor of plan.watashimo) {
    if (args.dryRun) {
      console.log(`  [dry] 私も ${actor.persona.radioName} -> ${plan.letter.id}`);
      did++;
    } else if (await post(plan, actor, "watashimo")) {
      total.watashimo++;
      did++;
    } else total.skipped++;
  }
  if (plan.reply) {
    const text = await replyText(client, plan.reply, plan.letter);
    if (text === null) total.skipped++;
    else if (args.dryRun) console.log(`  [dry] 一言 ${plan.reply.persona.radioName} (${plan.reply.persona.lang}) -> ${plan.letter.id}: ${text}`);
    else if (await post(plan, plan.reply, "reply", text)) {
      total.replies++;
      did++;
    } else total.skipped++;
  }
  if (did > 0 && !args.dryRun) total.reacted++;
}

async function main(): Promise<void> {
  args = parseReactionArgs(process.argv.slice(2), process.env);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new CliError("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  const actors = await loadActors();
  const letters = await loadLetters();
  const plans = planReactions(letters, actors, args.per);
  console.log(`personas: ${actors.length}, letters: ${letters.length}, to react to: ${plans.length}`);
  for (const plan of plans) await react(client, plan);
  console.log(
    args.dryRun
      ? `done (dry run): ${plans.length} letters planned, ${total.skipped} replies skipped`
      : `done: letters reacted ${total.reacted}, 私も ${total.watashimo}, 一言 ${total.replies}, skipped ${total.skipped}`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof CliError || (e instanceof Error && (e.message.startsWith("usage:") || e.message.startsWith("ADMIN_TOKEN"))) ? (e as Error).message : `unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  process.exitCode = 1;
});
