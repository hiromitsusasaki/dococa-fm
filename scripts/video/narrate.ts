/**
 * Reads the demo video's narration aloud with the production DJ voice: `synthesize(env, text, "male", "ja")`
 * from src/worker/tts/google.ts, so the style prompt and the guards are the same as on air.
 *
 *   node --env-file-if-exists=.dev.vars scripts/video/narrate.ts --lines lines.json --out dir [--max-calls 40] [--force]
 *
 * `lines.json` is `[{ "id": "n01", "say": "…", "lang"?: "ja" | "en" }]`, one sentence per entry. Each clip goes to
 * `<out>/<id>.mp3`; a clip already there is kept unless `--force`, so changing one sentence pays for that one only.
 * Paid calls are added up across runs in `<out>/calls.json`, and the run stops before it would pass `--max-calls`.
 * Env: GOOGLE_TTS_SA_JSON, GEMINI_TTS_MODEL. Prints ids and call counts only, never the key or the text.
 * Local only: the Worker never imports this file, and the media it writes stays outside the repo.
 */

type Line = { id: string; say: string; lang?: "ja" | "en" };
type Synthesize = (env: Record<string, string | undefined>, text: string, voice: "male", lang: "ja" | "en") => Promise<{ audio: ArrayBuffer; calls: number }>;
type Fs = {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  access(path: string): Promise<void>;
};
type NodeModule = {
  createRequire(from: string): { resolve(id: string): string };
  registerHooks(hooks: {
    resolve(specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown): unknown;
    load(url: string, context: unknown, next: (url: string, context: unknown) => { source?: unknown }): unknown;
  }): void;
};
type TransformSync = (filename: string, source: string) => { code: string; errors: unknown[] };

/** A short line is made twice (see google.ts), so the worst case of one line is this many calls. */
const WORST_CALLS_PER_LINE = 6;

/** Module ids in variables: the scripts' type space has no @types/node and must not pull in the Worker's. */
const NODE_MODULE = "node:module";
const NODE_FS = "node:fs/promises";
const GOOGLE_TTS = "../../src/worker/tts/google.ts";

function parseArgs(argv: string[]): { lines: string; out: string; maxCalls: number; force: boolean } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const lines = value("--lines");
  const out = value("--out");
  const maxCalls = Number(value("--max-calls") ?? "40");
  if (!lines || !out || !Number.isInteger(maxCalls) || maxCalls < 1) {
    throw new Error("usage: narrate.ts --lines lines.json --out dir [--max-calls 40] [--force]");
  }
  return { lines, out, maxCalls, force: argv.includes("--force") };
}

/**
 * The Worker's sources are written for the bundler: they import siblings without `.ts`, and google.ts uses a
 * constructor parameter property, which Node's type stripping cannot run. So the Worker's files get the
 * extension added and are compiled by the transformer Vite already ships (rolldown's), not stripped.
 */
async function loadWorkerSources(): Promise<void> {
  const { createRequire, registerHooks } = (await import(NODE_MODULE)) as NodeModule;
  const fromVite = createRequire(createRequire(import.meta.url).resolve("vite"));
  const { transformSync } = (await import(fromVite.resolve("rolldown/utils"))) as { transformSync: TransformSync };
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (!url.includes("/src/worker/") || !url.endsWith(".ts")) return loaded;
      const { code, errors } = transformSync(url, String(loaded.source));
      if (errors.length > 0) throw new Error(`cannot compile ${url.slice(url.indexOf("/src/worker/"))}`);
      return { format: "module", source: code, shortCircuit: true };
    },
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (e) {
        if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
        throw e;
      }
    },
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.GOOGLE_TTS_SA_JSON) throw new Error("GOOGLE_TTS_SA_JSON is not set");
  const fs = (await import(NODE_FS)) as Fs;
  await loadWorkerSources();
  const { synthesize } = (await import(GOOGLE_TTS)) as { synthesize: Synthesize };

  const lines = JSON.parse(await fs.readFile(args.lines, "utf8")) as Line[];
  await fs.mkdir(args.out, { recursive: true });
  const ledger = `${args.out}/calls.json`;
  let total = 0;
  try {
    total = (JSON.parse(await fs.readFile(ledger, "utf8")) as { calls: number }).calls;
  } catch {}

  const exists = (path: string) => fs.access(path).then(() => true, () => false);
  for (const line of lines) {
    // The id names the output file: a plain name only, so a narration file cannot write outside `--out`.
    if (!/^[A-Za-z0-9_-]+$/.test(line.id)) throw new Error(`invalid id: ${line.id}`);
    const path = `${args.out}/${line.id}.mp3`;
    if (!args.force && (await exists(path))) {
      console.log(`${line.id} kept`);
      continue;
    }
    if (total + WORST_CALLS_PER_LINE > args.maxCalls) throw new Error(`stopped before ${line.id}: ${total} calls used, cap ${args.maxCalls}`);
    try {
      const { audio, calls } = await synthesize(process.env, line.say, "male", line.lang ?? "ja");
      total += calls;
      await fs.writeFile(path, new Uint8Array(audio));
      console.log(`${line.id} made (${calls} calls)`);
    } catch (e) {
      // google.ts errors carry the status and the paid calls, never the text or the key.
      const calls = typeof (e as { calls?: unknown }).calls === "number" ? (e as { calls: number }).calls : 0;
      total += calls;
      console.log(`${line.id} failed: ${e instanceof Error ? e.message : "unknown"} (${calls} calls)`);
    } finally {
      await fs.writeFile(ledger, JSON.stringify({ calls: total }));
    }
  }
  console.log(`calls so far: ${total}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error && /^(usage:|stopped before|invalid id|GOOGLE_TTS_SA_JSON)/.test(e.message) ? e.message : `unexpected error: ${e instanceof Error ? e.name : "unknown"}`);
  process.exitCode = 1;
});
