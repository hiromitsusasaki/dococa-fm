import { getItemVecs } from "../db/items";
import { getLetter } from "../db/letters";
import type { Listener } from "../types";
import { ECHO_SQL, EXCLUDED_SQL, FAR_SQL, letterIdsSql, NEAR_SQL, NEIGHBOR_SQL, OWNER_FAVORITES_SQL } from "./select-sql";
import type { StationKey } from "./station";
import { farness, pickByDial, tasteOf } from "./taste";

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
  return candidates.length === 0 ? null : (shuffle(candidates, rng)[0] ?? null);
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

/**
 * The letter a listener asked to hear (a link to it): it must be someone else's public letter, or a found voice with
 * its source, and still readable. Its item takes the first seat with that letter read first. Anything else: null.
 */
async function askedLetter(db: D1Database, listener: Listener, letterId: string, rng: () => number): Promise<{ itemId: string; letterIds: string[] } | null> {
  const l = await getLetter(db, letterId);
  if (!l || l.status !== "public" || l.listenerId === listener.id) return null;
  const sourced = Boolean(l.sourceUrl?.trim()) && Boolean(l.sourceAuthor?.trim());
  if (!(l.kind === "letter" || (l.kind === "found" && sourced))) return null;
  const readable = (await letterIdsByItem(db, listener.id, [l.itemId])).get(l.itemId) ?? [];
  if (!readable.includes(l.id)) return null;
  const others = shuffle(readable.filter((id) => id !== l.id), rng);
  return { itemId: l.itemId, letterIds: [l.id, ...others].slice(0, MAX_LETTERS_PER_SEGMENT) };
}

/** A one-seat programme without distances: the dial picks which pool is tried first; the rest follow far, near, neighbor. */
function seatOrder(dial: number): Slot[] {
  const primary: Slot = dial >= 2 / 3 ? "far" : dial >= 1 / 3 ? "neighbor" : "near";
  return [primary, ...(["far", "near", "neighbor"] as const).filter((s) => s !== primary)];
}

const HEARD_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The one seat by distance: among the pool items that have a vector, minus the works heard in the last 7 days and
 * those of the last 30 episodes on this station (the first exclusion is lifted when nothing is left, then the
 * second), the dial's band of the listener's taste. Null when the listener has no taste yet or no candidate has a
 * vector: the pools then choose as before. The distance only chooses; it is not returned.
 */
async function pickByDistance(db: D1Database, listener: Listener, pool: string[], dial: number, rng: () => number): Promise<{ id: string; slot: Slot } | null> {
  const taste = await tasteOf(db, listener);
  if (!taste) return null;
  const vecs = await getItemVecs(db, pool);
  if (vecs.size === 0) return null;
  const since = new Date(Date.now() - HEARD_WITHIN_MS).toISOString();
  const { results } = await db.prepare(EXCLUDED_SQL).bind(listener.id, since).all<{ item_id: string; why: "heard" | "aired" }>();
  const heard = new Set(results.filter((r) => r.why === "heard").map((r) => r.item_id));
  const aired = new Set(results.filter((r) => r.why === "aired").map((r) => r.item_id));
  const all = [...vecs.keys()].sort();
  const fresh = all.filter((id) => !heard.has(id) && !aired.has(id));
  const notAired = all.filter((id) => !aired.has(id));
  const cands = fresh.length > 0 ? fresh : notAired.length > 0 ? notAired : all;
  return pickByDial(cands, farness(taste, new Map(cands.map((id) => [id, vecs.get(id) as Float32Array]))), dial, rng);
}

export async function selectProgram(
  db: D1Database,
  listener: Listener,
  opts: { size?: number; seed?: string; station?: StationKey; dial?: number; letterId?: string } = {},
): Promise<Selection[]> {
  const size = Math.max(0, Math.floor(opts.size ?? 6));
  const rng = seededRng(opts.seed ?? crypto.randomUUID());
  if (opts.station?.kind === "world") return worldProgram(db, listener, size, rng);
  if (opts.station?.kind === "public") return publicProgram(db, listener, opts.station.ownerId, size, rng);
  // The dial the player sends wins over the stored one.
  const dial = Math.min(1, Math.max(0, opts.dial ?? listener.dial));
  const asked = size > 0 && opts.letterId ? await askedLetter(db, listener, opts.letterId, rng) : null;
  const room = size - (asked ? 1 : 0);

  const farQuota = Math.min(room, Math.max(1, Math.round(room * dial)));
  const remaining = room - farQuota;
  const nearQuota = Math.round((remaining * 2) / 3);
  const neighborQuota = remaining - nearQuota;

  // With one seat the echo takes it unless the dial is at the far end; a letter the listener asked for leaves no room for it.
  const echoRoom = asked ? false : room === 1 ? dial < 2 / 3 : nearQuota > 0;
  const echo = echoRoom ? await echoItem(db, listener, rng) : null;
  const taken = new Set<string>([...(echo ? [echo] : []), ...(asked ? [asked.itemId] : [])]);
  const raw: Record<Slot, string[]> = {
    near: await ids(db, NEAR_SQL, listener.id),
    neighbor: await ids(db, NEIGHBOR_SQL, listener.id),
    far: await ids(db, FAR_SQL, listener.id),
  };
  const pools: Record<Slot, string[]> = {
    near: shuffle(raw.near.filter((id) => !taken.has(id)), rng),
    neighbor: shuffle(raw.neighbor.filter((id) => !taken.has(id)), rng),
    far: shuffle(raw.far.filter((id) => !taken.has(id)), rng),
  };

  const chosen: Record<Slot, string[]> = { near: echo ? [echo] : [], neighbor: [], far: [] };
  const count = () => chosen.near.length + chosen.neighbor.length + chosen.far.length;
  if (room === 1) {
    const byDistance = echo ? null : await pickByDistance(db, listener, [...pools.near, ...pools.neighbor, ...pools.far], dial, rng);
    if (byDistance) chosen[byDistance.slot].push(byDistance.id);
    for (const slot of seatOrder(dial)) if (count() < 1) chosen[slot].push(...pools[slot].splice(0, 1));
  } else if (room > 1) {
    // The echo item uses one unit of the near quota; it never adds to the program size.
    const nearRoom = nearQuota - (echo ? 1 : 0);
    const quota: Record<Slot, number> = { near: nearRoom, neighbor: neighborQuota, far: farQuota };
    for (const slot of ["near", "neighbor", "far"] as const) chosen[slot].push(...pools[slot].splice(0, Math.max(0, quota[slot])));
    // Seats near and neighbor cannot fill go to far (then to whatever is left), never to works nobody has written about.
    for (const slot of ["far", "near", "neighbor"] as const) {
      if (count() >= room) break;
      chosen[slot].push(...pools[slot].splice(0, room - count()));
    }
  }

  const readable = await letterIdsByItem(db, listener.id, [...chosen.near, ...chosen.neighbor, ...chosen.far]);
  const segments: Record<Slot, Selection[]> = { near: [], neighbor: [], far: [] };
  for (const slot of ["near", "neighbor", "far"] as const) {
    for (const itemId of chosen[slot]) {
      segments[slot].push({ itemId, slot, letterIds: shuffle(readable.get(itemId) ?? [], rng).slice(0, MAX_LETTERS_PER_SEGMENT) });
    }
  }

  // The asked letter's item sits where the pools put it; an item no pool holds (nobody else wrote yet) counts as near.
  const askedSlot: Slot = asked ? ((["near", "neighbor", "far"] as const).find((s) => raw[s].includes(asked.itemId)) ?? "near") : "near";
  const head = asked ? [{ itemId: asked.itemId, slot: askedSlot, letterIds: asked.letterIds }] : [];
  const first = echo ? segments.near.splice(0, 1) : [];
  // The echo stays even without a letter: the reactions it carries are other people's words, read verbatim.
  return [...head, ...first, ...interleave([segments.near, segments.neighbor, segments.far]).filter(hasLetters)];
}
