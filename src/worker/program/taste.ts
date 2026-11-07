import { dequantise, normalise } from "../db/items";
import { countOwnLetters } from "../db/letters";
import type { Listener } from "../types";
import { TASTE_HEARD_SQL, TASTE_OWN_SQL } from "./select-sql";
import type { Slot } from "./select";

/** The mean of the rows' vectors (null when none has one), and whether the query found any row at all. */
async function meanOf(db: D1Database, sql: string, listenerId: string): Promise<{ mean: Float32Array | null; any: boolean }> {
  const { results } = await db.prepare(sql).bind(listenerId).all<{ vec: unknown }>();
  let sum: Float32Array | null = null;
  for (const r of results) {
    const v = dequantise(r.vec);
    if (!v) continue;
    sum ??= new Float32Array(v.length);
    if (v.length !== sum.length) continue;
    for (let i = 0; i < v.length; i++) sum[i] = (sum[i] as number) + (v[i] as number);
  }
  return { mean: sum ? normalise(sum) : null, any: results.length > 0 };
}

/**
 * Where the listener stands: the mean of the vectors of up to 50 works they spoke about themselves (their own letters,
 * and the letters they answered with a 私も or a 一言; favourites never count), else of up to 20 works they heard most
 * recently, as a unit vector; null when none of those has a vector. `blank`: the listener has written nothing, reacted
 * to nothing and heard nothing yet (a cold start), whether or not the works have vectors.
 */
export async function standingOf(db: D1Database, listener: Pick<Listener, "id">): Promise<{ taste: Float32Array | null; blank: boolean }> {
  const own = await meanOf(db, TASTE_OWN_SQL, listener.id);
  if (own.mean) return { taste: own.mean, blank: false };
  const heard = await meanOf(db, TASTE_HEARD_SQL, listener.id);
  return { taste: heard.mean, blank: !own.any && !heard.any };
}

/** The dial wakes once the listener has this many own voices: letters sent and reactions. */
export const DIAL_WAKES_AT = 3;

/** Whether the listener's dial works yet (see `DIAL_WAKES_AT`). Before, the radio shows it locked. */
export async function dialAwake(db: D1Database, listenerId: string): Promise<boolean> {
  return (await countOwnLetters(db, listenerId)) >= DIAL_WAKES_AT;
}

/** The listener's taste alone (see `standingOf`). */
export async function tasteOf(db: D1Database, listener: Pick<Listener, "id">): Promise<Float32Array | null> {
  return (await standingOf(db, listener)).taste;
}

/**
 * How far each candidate lies from the taste, as a percentile of the candidates (0 the nearest, 1 the farthest):
 * ranked by cosine distance; equal distances share their mid-rank, so two identical works never land on opposite
 * ends of the dial; the ids only keep the output order stable. One candidate is at 0. Used to choose only: it never
 * leaves the worker.
 */
export function farness(taste: Float32Array, cands: Map<string, Float32Array>): Map<string, number> {
  const dist = [...cands].map(([id, v]) => {
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += (v[i] as number) * (taste[i] ?? 0);
    return { id, d: 1 - dot };
  });
  dist.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = dist.length;
  const out = new Map<string, number>();
  for (let start = 0; start < n; ) {
    let end = start;
    while (end + 1 < n && (dist[end + 1] as { d: number }).d === (dist[start] as { d: number }).d) end++;
    const mid = (start + end) / 2;
    for (let i = start; i <= end; i++) out.set((dist[i] as { id: string }).id, n === 1 ? 0 : mid / (n - 1));
    start = end + 1;
  }
  return out;
}

/** The band around the dial starts at ±0.2 and widens by 0.1 until it holds a candidate. */
const BAND = 0.2;
const WIDEN = 0.1;

/**
 * One of `ids` (each must be in `far`) whose percentile lies within the band around the dial, uniformly at random,
 * with the slot its percentile falls in: near below 1/3, neighbor below 2/3, far above.
 */
export function pickByDial(ids: readonly string[], far: Map<string, number>, dial: number, rng: () => number): { id: string; slot: Slot } | null {
  const ranked = ids.filter((id) => far.has(id));
  if (ranked.length === 0) return null;
  // Rounding keeps the widening steps exact (0.2, 0.3, ...), so a candidate on the edge is not lost to float error.
  for (let w = BAND; ; w = Math.round((w + WIDEN) * 10) / 10) {
    const band = ranked.filter((id) => Math.abs((far.get(id) as number) - dial) <= w + 1e-9);
    if (band.length > 0) {
      const id = band[Math.min(band.length - 1, Math.floor(rng() * band.length))] as string;
      const p = far.get(id) as number;
      return { id, slot: p < 1 / 3 ? "near" : p < 2 / 3 ? "neighbor" : "far" };
    }
  }
}
