import { countItemsWithoutVec, listItemsWithoutMix, listItemsWithoutVec, MIXED_LETTER, normalise, refreshItemMix, setItemVecs, VEC_DIMS } from "../db/items";
import { setLetterVecs } from "../db/letters";
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
 * Embeds `pending`, 20 to a call, and stores each batch with `store`. A call that fails is tried again one row at a
 * time: a row that fails alone is skipped for this run (logged with its id and the error's name, never its text), so
 * one row Workers AI refuses does not stall the rest. When every row of the batch fails alone too, Workers AI itself is
 * down and the run stops. Returns how many were stored.
 */
async function embedEach<T extends { id: string }>(ai: Ai, pending: T[], text: (row: T) => string, store: (entries: Array<[T, Float32Array]>) => Promise<void>): Promise<number> {
  const skipped = new Set<string>();
  let made = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH) {
    const batch = pending.slice(i, i + EMBED_BATCH).filter((it) => !skipped.has(it.id));
    if (batch.length === 0) continue;
    try {
      const vecs = await embedOrThrow(ai, batch.map(text));
      await store(batch.map((it, k) => [it, vecs[k] as Float32Array]));
      made += batch.length;
      continue;
    } catch (e) {
      console.error(`[dococa] embed failed: ${errorName(e)}`);
    }
    let alone = 0;
    for (const it of batch) {
      try {
        const [vec] = await embedOrThrow(ai, [text(it)]);
        await store([[it, vec as Float32Array]]);
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
}

/** Embeds the items among `ids` that have no vector yet (see `embedEach`). Returns how many were stored. Never throws (routes `defer` it). */
export async function embedItems(env: Pick<Env, "AI">, db: D1Database, ids: string[]): Promise<number> {
  const ai = env.AI;
  if (!ai) {
    unbound();
    return 0;
  }
  try {
    return await embedEach(ai, await listUnembedded(db, ids), itemText, (entries) => setItemVecs(db, entries.map(([it, v]) => [it.id, v])));
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

/** What is embedded for a public letter or 一言: its work's metadata, then its text as written (bge-m3 reads any language). */
export const letterText = (l: Unembedded & { body: string }): string => `${itemText(l)}\n${l.body}`;

type UnembeddedLetter = Unembedded & { body: string; itemId: string };

const UNEMBEDDED_LETTERS = `SELECT l.id, l.item_id AS itemId, l.body, i.title, i.creator, i.year, i.kind FROM letters l JOIN items i ON i.id = l.item_id
  WHERE l.vec IS NULL AND ${MIXED_LETTER("l")}`;

/**
 * Embeds the public letters and 一言 among `ids` (or, with `limit`, the newest without one) that have no vector yet,
 * stores them, and remakes their works' mixes. 私も and found voices get none. The letter's text is sent to Workers AI
 * only: it never reaches the log, nor does a vector. Returns how many were stored. Never throws (routes `defer` it).
 */
export async function embedLetters(env: Pick<Env, "AI">, db: D1Database, which: { ids: string[] } | { limit: number }): Promise<number> {
  const ai = env.AI;
  if (!ai) {
    unbound();
    return 0;
  }
  try {
    let pending: UnembeddedLetter[] = [];
    if ("ids" in which) {
      const unique = [...new Set(which.ids)];
      for (let i = 0; i < unique.length; i += 90) {
        const chunk = unique.slice(i, i + 90);
        const { results } = await db.prepare(`${UNEMBEDDED_LETTERS} AND l.id IN (${chunk.map(() => "?").join(", ")}) ORDER BY l.created_at DESC, l.id`).bind(...chunk).all<UnembeddedLetter>();
        pending.push(...results);
      }
    } else {
      pending = (await db.prepare(`${UNEMBEDDED_LETTERS} ORDER BY l.created_at DESC, l.id LIMIT ?`).bind(Math.max(0, which.limit)).all<UnembeddedLetter>()).results;
    }
    // Each work's mix is remade once, after every batch is stored, however many of its letters were embedded.
    const touched = new Set<string>();
    const made = await embedEach(ai, pending, letterText, async (entries) => {
      await setLetterVecs(db, entries.map(([l, v]) => [l.id, v]));
      for (const [l] of entries) touched.add(l.itemId);
    });
    for (const itemId of touched) await refreshItemMix(db, itemId);
    return made;
  } catch (e) {
    console.error(`[dococa] embed letters failed: ${e instanceof Error ? e.name : "unknown"}`);
    return 0;
  }
}

export async function countLettersWithoutVec(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM letters l WHERE l.vec IS NULL AND ${MIXED_LETTER("l")}`).first<{ n: number }>())?.n ?? 0;
}

/**
 * The prepare run's letter stage: up to `budget` calls of 20 public letters and 一言 still without a vector, newest
 * first, then the mixes of up to `budget` x 20 works a missed refresh left without one. `remaining` counts the letters
 * still without a vector.
 */
export async function ensureLetterVectors(env: Pick<Env, "AI">, db: D1Database, budget: number): Promise<{ made: number; remaining: number }> {
  const made = env.AI && budget > 0 ? await embedLetters(env, db, { limit: budget * EMBED_BATCH }) : 0;
  for (const id of await listItemsWithoutMix(db, Math.max(0, budget) * EMBED_BATCH)) await refreshItemMix(db, id);
  return { made, remaining: await countLettersWithoutVec(db) };
}

/** Remakes the mix of the work of a letter that stopped being public (withdrawn or rejected). Never throws (routes `defer` it). */
export async function remixAfterTakedown(db: D1Database, letterId: string): Promise<void> {
  try {
    const row = await db.prepare("SELECT item_id FROM letters WHERE id = ?").bind(letterId).first<{ item_id: string }>();
    if (row) await refreshItemMix(db, row.item_id);
  } catch (e) {
    console.error(`[dococa] remix failed: ${e instanceof Error ? e.name : "unknown"}`);
  }
}
