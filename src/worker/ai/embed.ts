import { countItemsWithoutVec, listItemsWithoutVec, normalise, setItemVecs, VEC_DIMS } from "../db/items";
import type { Env } from "../env";
import type { Item } from "../types";

export const EMBED_MODEL = "@cf/baai/bge-m3";
/** Texts per Workers AI call. */
export const EMBED_BATCH = 20;

let warnedUnbound = false;
/** Without the binding nothing is embedded and the pick falls back to the pools; said once per isolate, not as an error. */
function unbound(): null {
  if (!warnedUnbound) console.warn("[dococa] workers ai not bound; works get no vectors");
  warnedUnbound = true;
  return null;
}

/**
 * One unit vector per text, in order, or null when Workers AI is not bound, the call throws or the answer is out of
 * shape. The log carries the error's name only: never the texts, never a vector.
 */
export async function embed(env: Pick<Env, "AI">, texts: string[]): Promise<Float32Array[] | null> {
  if (!env.AI) return unbound();
  try {
    return await embedOrThrow(env.AI, texts);
  } catch (e) {
    console.error(`[dococa] embed failed: ${e instanceof Error ? e.name : "unknown"}`);
    return null;
  }
}

/** One unit vector per text, in order; throws when the call does or the answer is out of shape. */
async function embedOrThrow(ai: Ai, texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const out = (await ai.run(EMBED_MODEL, { text: texts })) as { data?: unknown };
  const data = out?.data;
  if (!Array.isArray(data) || data.length !== texts.length) throw new TypeError("embedding out of shape");
  return data.map((row) => {
    if (!Array.isArray(row) || row.length !== VEC_DIMS || !row.every((x) => typeof x === "number" && Number.isFinite(x))) throw new TypeError("embedding out of shape");
    return normalise(Float32Array.from(row as number[]));
  });
}

/** What is embedded for a work: its public metadata only, never a letter. */
export const itemText = (i: Pick<Item, "title" | "creator" | "year" | "kind">): string => `${i.title} — ${i.creator}${i.year ? ` (${i.year})` : ""} [${i.kind}]`;

type Unembedded = Pick<Item, "id" | "title" | "creator" | "year" | "kind">;

/** The items among `ids` without a vector, in one statement per 90 ids. */
async function listUnembedded(db: D1Database, ids: string[]): Promise<Unembedded[]> {
  const unique = [...new Set(ids)];
  const out: Unembedded[] = [];
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT id, title, creator, year, kind FROM items WHERE vec IS NULL AND id IN (${chunk.map(() => "?").join(", ")}) ORDER BY created_at DESC, id`)
      .bind(...chunk)
      .all<Unembedded>();
    out.push(...results);
  }
  return out;
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/**
 * Embeds the items among `ids` that have no vector yet, 20 to a call, and stores them. A call that fails is tried
 * again one work at a time: a work that fails alone is skipped for this run (logged with its id and the error's
 * name, never its text), so one work Workers AI refuses does not stall the rest. When every work of the batch fails
 * alone too, Workers AI itself is down and the run stops. Returns how many were stored. Never throws (routes `defer` it).
 */
export async function embedItems(env: Pick<Env, "AI">, db: D1Database, ids: string[]): Promise<number> {
  const ai = env.AI;
  if (!ai) {
    unbound();
    return 0;
  }
  try {
    const pending = await listUnembedded(db, ids);
    const skipped = new Set<string>();
    let made = 0;
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH).filter((it) => !skipped.has(it.id));
      if (batch.length === 0) continue;
      try {
        const vecs = await embedOrThrow(ai, batch.map(itemText));
        await setItemVecs(db, batch.map((it, k) => [it.id, vecs[k] as Float32Array]));
        made += batch.length;
        continue;
      } catch (e) {
        console.error(`[dococa] embed failed: ${errorName(e)}`);
      }
      let alone = 0;
      for (const it of batch) {
        try {
          const [vec] = await embedOrThrow(ai, [itemText(it)]);
          await setItemVecs(db, [[it.id, vec as Float32Array]]);
          made++;
          alone++;
        } catch (e) {
          skipped.add(it.id);
          console.warn(`[dococa] embed skipped ${it.id} ${errorName(e)}`);
        }
      }
      if (alone === 0) break;
    }
    return made;
  } catch (e) {
    console.error(`[dococa] embed items failed: ${e instanceof Error ? e.name : "unknown"}`);
    return 0;
  }
}

/**
 * The cron's vector stage: up to `budget` calls of 20 items still without a vector, newest first. `remaining` counts
 * the items still without one afterwards.
 */
export async function ensureItemVectors(env: Pick<Env, "AI">, db: D1Database, budget: number): Promise<{ made: number; remaining: number }> {
  const made = env.AI && budget > 0 ? await embedItems(env, db, await listItemsWithoutVec(db, budget * EMBED_BATCH)) : 0;
  return { made, remaining: await countItemsWithoutVec(db) };
}
