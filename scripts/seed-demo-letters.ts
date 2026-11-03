/**
 * Seeds the demo with letters from AI-made, multinational dummy listeners, flagged `demo` so that
 * every screen says so.
 *
 *   pnpm seed --items items.txt --personas 30     make personas, write their letters, post them
 *   pnpm seed --items items.txt --dry-run         the same, but posts nothing (still writes docs/demo/personas.json)
 *   pnpm seed --items items.txt --reuse           keep docs/demo/personas.json instead of making new personas
 *
 * `items.txt` has one work url per line. Env: ANTHROPIC_API_KEY, ADMIN_TOKEN, DOCOCA_ORIGIN (default
 * http://127.0.0.1:5173). pnpm loads .dev.vars for you. Local only: the Worker never imports this file.
 *
 * Each persona gets one Claude call. Claude answers through one strict tool; its lines that break a rule
 * (200 characters, time-bound words, contact details, ranking talk, real names) are dropped whole and never
 * edited, so what is posted is exactly what the model wrote. After posting, the item page is fetched and
 * must show each line character for character. The people are fictional and `docs/demo/personas.json`
 * may be public; letters from them are not a replacement for real listeners' letters.
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  LETTER_SYSTEM,
  LETTER_TOOL,
  MODEL,
  PERSONA_BATCH,
  PERSONA_SYSTEM,
  PERSONA_TOOL,
  type Args,
  type Persona,
  type SeedItem,
  letterPrompt,
  pageShows,
  parseArgs,
  parseItemUrls,
  parseLetters,
  parsePersonas,
  personaPrompt,
  pickItems,
} from "./lib/seed.ts";

const PERSONAS_FILE = "docs/demo/personas.json";
const MAX_ROUNDS = 5;

class CliError extends Error {}

let args: Args;

/** Calls the admin API. Error text carries the status and the API's own message, never the token. */
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

/** One request with one strict tool and `tool_choice: auto` (Sonnet 5.5 rejects a forced choice); null unless exactly one call came back. */
async function callTool(client: Anthropic, req: { system: string; user: string; tool: typeof PERSONA_TOOL | typeof LETTER_TOOL; maxTokens: number }): Promise<unknown> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: req.maxTokens,
    system: `${req.system}\n必ず ${req.tool.name} ツールを 1 回だけ呼んで答える。ほかの文章は書かない。`,
    tools: [{ ...req.tool, strict: true }],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: req.user }],
  });
  const calls = res.content.filter((b) => b.type === "tool_use" && b.name === req.tool.name);
  const [only] = calls;
  return calls.length === 1 && only?.type === "tool_use" ? only.input : null;
}

async function resolveItems(urls: string[]): Promise<SeedItem[]> {
  const items: SeedItem[] = [];
  for (const url of urls) {
    const r = await admin("POST", "/admin/items", { url });
    if (r.status !== 200) {
      console.warn(`skip item (${r.status}): ${url}`);
      continue;
    }
    const { id, title, creator, kind } = r.json.item;
    items.push({ id, title, creator, kind, url });
  }
  return items;
}

async function makePersonas(client: Anthropic, count: number): Promise<Persona[]> {
  const personas: Persona[] = [];
  for (let round = 0; round < MAX_ROUNDS && personas.length < count; round++) {
    const want = Math.min(PERSONA_BATCH, count - personas.length);
    const raw = await callTool(client, { system: PERSONA_SYSTEM, user: personaPrompt(want, personas), tool: PERSONA_TOOL, maxTokens: 4000 });
    const { personas: got, dropped } = parsePersonas(raw, personas);
    for (const d of dropped) console.warn(`dropped ${d}`);
    personas.push(...got.slice(0, want));
  }
  return personas;
}

async function loadOrMakePersonas(client: Anthropic): Promise<Persona[]> {
  const personas = args.reuse ? parsePersonas(JSON.parse(await readFile(PERSONAS_FILE, "utf8"))).personas.slice(0, args.personas) : await makePersonas(client, args.personas);
  if (personas.length === 0) throw new CliError("no valid personas");
  if (!args.reuse) {
    await mkdir("docs/demo", { recursive: true });
    await writeFile(PERSONAS_FILE, `${JSON.stringify({ note: "All fictional, made by AI for the demo. No real person is meant.", personas }, null, 2)}\n`);
    console.log(`wrote ${PERSONAS_FILE} (${personas.length})`);
  }
  return personas;
}

async function seedPersona(client: Anthropic, persona: Persona, assigned: SeedItem[]): Promise<{ posted: number; skipped: number; mismatched: number }> {
  const raw = await callTool(client, { system: LETTER_SYSTEM, user: letterPrompt(persona, assigned), tool: LETTER_TOOL, maxTokens: 2000 });
  const { letters, dropped } = parseLetters(raw, persona, assigned);
  for (const d of dropped) console.warn(`  dropped ${persona.radioName} ${d}`);
  let skipped = dropped.length;
  let posted = 0;
  let mismatched = 0;
  if (letters.length === 0) return { posted, skipped, mismatched };

  if (args.dryRun) {
    for (const l of letters) console.log(`  [dry] ${persona.radioName} -> ${assigned.find((i) => i.id === l.itemId)?.title}: ${l.body}`);
    return { posted: 0, skipped, mismatched };
  }

  const made = await admin("POST", "/admin/listeners", { radioName: persona.radioName, place: `${persona.place}、${persona.country}`, demo: true });
  if (made.status !== 200) return fail("POST /admin/listeners", made);
  for (const l of letters) {
    const r = await admin("POST", "/admin/letters", { listenerId: made.json.id, itemId: l.itemId, body: l.body });
    if (r.status !== 200) {
      skipped++;
      console.warn(`  not posted (${r.status} ${JSON.stringify(r.json).slice(0, 120)}): ${persona.radioName} / ${l.itemId}`);
      continue;
    }
    posted++;
    const page = await (await fetch(`${args.origin}/items/${r.json.itemId}`)).text();
    if (!pageShows(page, l.body)) {
      mismatched++;
      console.error(`  ORIGINAL NOT SHOWN VERBATIM on /items/${r.json.itemId}: ${l.body}`);
    }
  }
  return { posted, skipped, mismatched };
}

async function main(): Promise<void> {
  args = parseArgs(process.argv.slice(2), process.env);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new CliError("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  const urls = parseItemUrls(await readFile(args.items, "utf8"));
  if (urls.length === 0) throw new CliError(`no item urls in ${args.items}`);
  const items = await resolveItems(urls);
  if (items.length === 0) throw new CliError("none of the item urls could be resolved");
  console.log(`items: ${items.length}`);

  const personas = await loadOrMakePersonas(client);
  const total = { posted: 0, skipped: 0, mismatched: 0 };
  for (const [index, persona] of personas.entries()) {
    const assigned = pickItems(items.map((i) => i.url), index).map((u) => items.find((i) => i.url === u)!);
    console.log(`${persona.radioName} (${persona.country}, ${persona.lang}): ${assigned.length} items`);
    const r = await seedPersona(client, persona, assigned);
    total.posted += r.posted;
    total.skipped += r.skipped;
    total.mismatched += r.mismatched;
  }
  console.log(`done: posted ${total.posted}, not posted ${total.skipped}, not shown verbatim ${total.mismatched}${args.dryRun ? " (dry run)" : ""}`);
  if (total.mismatched > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof CliError || (e instanceof Error && e.message.startsWith("usage:")) ? (e as Error).message : `unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  process.exitCode = 1;
});
