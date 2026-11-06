import type { Listener } from "../types";
import { ECHO_SQL, FAR_SQL, letterIdsSql, NEAR_SQL, NEIGHBOR_SQL, OWNER_FAVORITES_SQL } from "./select-sql";
import type { StationKey } from "./station";

export type Slot = "near" | "neighbor" | "far";
export type Selection = { itemId: string; slot: Slot; letterIds: string[] };

const MAX_LETTERS_PER_SEGMENT = 3;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 seeded from the FNV-1a hash of `seed`; returns floats in [0, 1). */
export function seededRng(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates on a copy. */
export function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

async function ids(db: D1Database, sql: string, ...binds: unknown[]): Promise<string[]> {
  const { results } = await db.prepare(sql).bind(...binds).all<{ item_id: string }>();
  return results.map((r) => r.item_id);
}

async function echoItem(db: D1Database, listener: Listener, rng: () => number): Promise<string | null> {
  const candidates = await ids(db, ECHO_SQL, listener.id);
  // An echo nobody else has written about would have nothing to read, so it cannot take a seat.
  const readable = await letterIdsByItem(db, listener.id, candidates);
  const airable = candidates.filter((id) => readable.has(id));
  return airable.length === 0 ? null : (shuffle(airable, rng)[0] ?? null);
}

/** Readable letter ids of every chosen item, in one query; each item's list is ordered by id, as the shuffle expects. */
async function letterIdsByItem(db: D1Database, listenerId: string, itemIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (itemIds.length === 0) return out;
  const { results } = await db.prepare(letterIdsSql(itemIds.length)).bind(listenerId, ...itemIds).all<{ id: string; item_id: string }>();
  for (const r of results) out.set(r.item_id, [...(out.get(r.item_id) ?? []), r.id]);
  return out;
}

/** Take items round-robin across the lists so no kind is front-loaded. */
function interleave(lists: Selection[][]): Selection[] {
  const out: Selection[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i] as Selection);
  return out;
}

const hasLetters = (s: Selection): boolean => s.letterIds.length > 0;

/** Letters the listener may hear for each item, up to the per-segment cap, in a seeded order. */
async function withLetters(db: D1Database, listener: Listener, itemIds: string[], slot: Slot, rng: () => number): Promise<Selection[]> {
  const readable = await letterIdsByItem(db, listener.id, itemIds);
  return itemIds.map((itemId) => ({ itemId, slot, letterIds: shuffle(readable.get(itemId) ?? [], rng).slice(0, MAX_LETTERS_PER_SEGMENT) }));
}

/** The world station: far only, for anyone. No echo: nothing here is the listener's own. */
async function worldProgram(db: D1Database, listener: Listener, size: number, rng: () => number): Promise<Selection[]> {
  const pool = shuffle(await ids(db, FAR_SQL, listener.id), rng).slice(0, size);
  return withLetters(db, listener, pool, "far", rng);
}

/** A public station: the owner's favourites that someone has written about. The rest wait until a letter arrives. */
async function publicProgram(db: D1Database, listener: Listener, ownerId: string, size: number, rng: () => number): Promise<Selection[]> {
  const pool = shuffle(await ids(db, OWNER_FAVORITES_SQL, ownerId), rng).slice(0, size);
  return (await withLetters(db, listener, pool, "near", rng)).filter(hasLetters);
}

export async function selectProgram(
  db: D1Database,
  listener: Listener,
  opts: { size?: number; seed?: string; station?: StationKey } = {},
): Promise<Selection[]> {
  const size = Math.max(0, Math.floor(opts.size ?? 6));
  const rng = seededRng(opts.seed ?? crypto.randomUUID());
  if (opts.station?.kind === "world") return worldProgram(db, listener, size, rng);
  if (opts.station?.kind === "public") return publicProgram(db, listener, opts.station.ownerId, size, rng);
  const dial = Math.min(1, Math.max(0, listener.dial));

  const farQuota = Math.min(size, Math.max(1, Math.round(size * dial)));
  const remaining = size - farQuota;
  const nearQuota = Math.round((remaining * 2) / 3);
  const neighborQuota = remaining - nearQuota;

  const echo = nearQuota > 0 ? await echoItem(db, listener, rng) : null;
  const taken = new Set<string>(echo ? [echo] : []);
  const pool = async (sql: string) => shuffle((await ids(db, sql, listener.id)).filter((id) => !taken.has(id)), rng);

  const pools: Record<Slot, string[]> = {
    near: await pool(NEAR_SQL),
    neighbor: await pool(NEIGHBOR_SQL),
    far: await pool(FAR_SQL),
  };

  const chosen: Record<Slot, string[]> = { near: echo ? [echo] : [], neighbor: [], far: [] };
  // The echo item uses one unit of the near quota; it never adds to the program size.
  const nearRoom = nearQuota - (echo ? 1 : 0);
  const quota: Record<Slot, number> = { near: nearRoom, neighbor: neighborQuota, far: farQuota };
  for (const slot of ["near", "neighbor", "far"] as const) chosen[slot].push(...pools[slot].splice(0, Math.max(0, quota[slot])));
  // Seats near and neighbor cannot fill go to far (then to whatever is left), never to works nobody has written about.
  const count = () => chosen.near.length + chosen.neighbor.length + chosen.far.length;
  for (const slot of ["far", "near", "neighbor"] as const) {
    if (count() >= size) break;
    chosen[slot].push(...pools[slot].splice(0, size - count()));
  }

  const readable = await letterIdsByItem(db, listener.id, [...chosen.near, ...chosen.neighbor, ...chosen.far]);
  const segments: Record<Slot, Selection[]> = { near: [], neighbor: [], far: [] };
  for (const slot of ["near", "neighbor", "far"] as const) {
    for (const itemId of chosen[slot]) {
      segments[slot].push({ itemId, slot, letterIds: shuffle(readable.get(itemId) ?? [], rng).slice(0, MAX_LETTERS_PER_SEGMENT) });
    }
  }

  const first = echo ? segments.near.splice(0, 1) : [];
  return [...first, ...interleave([segments.near, segments.neighbor, segments.far])].filter(hasLetters);
}
