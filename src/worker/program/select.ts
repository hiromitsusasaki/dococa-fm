import { getItemVecs } from "../db/items";
import { getLetter } from "../db/letters";
import type { Letter, Listener } from "../types";
import { ECHO_SQL, EXCLUDED_SQL, FAR_SQL, FRESH_PLACE_LETTERS_SQL, letterIdsSql, NEAR_SQL, NEIGHBOR_SQL, PUBLIC_ANY_SQL, PUBLIC_LETTERS_SQL } from "./select-sql";
import { type StationKey, stationColumn } from "./station";
import { farness, pickByDial, standingOf } from "./taste";

export type Slot = "near" | "neighbor" | "far";
/**
 * One segment: a work and the one letter it reads (none in an echo of reactions only). On a public radio,
 * `ownerReplyIds` is the owner's 一言 on that letter, read after it.
 */
export type Selection = { itemId: string; slot: Slot; letterIds: string[]; ownerReplyIds?: string[] };

/** A letter heard within this long waits; then it may air again. */
const HEARD_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Items per letter query: D1 binds at most 100 parameters, and the listener id and the time take two. */
const LETTER_QUERY_ITEMS = 90;

/** A letter the DJ may read, and whether the listener heard it in the last 7 days. */
type Readable = { id: string; heard: boolean };

/** Readable letters of every chosen item, one query per 90 items; each item's list has the unheard first, the oldest first. */
async function lettersByItem(db: D1Database, listenerId: string, since: string, itemIds: string[]): Promise<Map<string, Readable[]>> {
  const out = new Map<string, Readable[]>();
  for (let i = 0; i < itemIds.length; i += LETTER_QUERY_ITEMS) {
    const chunk = itemIds.slice(i, i + LETTER_QUERY_ITEMS);
    const { results } = await db.prepare(letterIdsSql(chunk.length)).bind(listenerId, since, ...chunk).all<{ id: string; item_id: string; heard: number }>();
    for (const r of results) out.set(r.item_id, [...(out.get(r.item_id) ?? []), { id: r.id, heard: r.heard === 1 }]);
  }
  return out;
}

/**
 * The one letter a segment reads among its work's: the first the listener has not heard lately, the oldest first, so
 * the letters of a work take turns. At a cold start a letter from a fresh place goes before the others of its kind.
 */
function oneLetter(letters: readonly Readable[] = [], freshPlace: ReadonlySet<string> | null = null): string[] {
  const order = freshPlace ? [...letters].sort((a, b) => Number(a.heard) - Number(b.heard) || Number(freshPlace.has(b.id)) - Number(freshPlace.has(a.id))) : letters;
  return order[0] ? [order[0].id] : [];
}

/** What waits on a station: works with every letter heard lately, works of the last three segments there, and the latest segment's work. */
type Recent = { spent: ReadonlySet<string>; aired: ReadonlySet<string>; latest: ReadonlySet<string> };

async function recentOn(db: D1Database, listenerId: string, since: string, station: string): Promise<Recent> {
  const { results } = await db.prepare(EXCLUDED_SQL).bind(listenerId, since, station).all<{ item_id: string; why: keyof Recent }>();
  const of = (why: keyof Recent) => new Set(results.filter((r) => r.why === why).map((r) => r.item_id));
  return { spent: of("spent"), aired: of("aired"), latest: of("latest") };
}

/** 0: nothing waits; 1: every letter heard lately; 2: aired in the last three segments; 3: the latest segment's work. The lower is tried first. */
function staleness(r: Recent, id: string): number {
  return r.latest.has(id) ? 3 : r.aired.has(id) ? 2 : r.spent.has(id) ? 1 : 0;
}

/**
 * The candidates in the order they are tried: the exclusions are lifted one at a time when nothing fresher is left, and
 * the latest segment's work comes last, so it airs again only when it is the only one. The sort is stable: the shuffle
 * still decides within each rank.
 */
function freshestFirst<T>(xs: readonly T[], r: Recent, idOf: (x: T) => string): T[] {
  return [...xs].sort((a, b) => staleness(r, idOf(a)) - staleness(r, idOf(b)));
}

const self = (id: string) => id;

/** The flagged ones first; the sort is stable, so the shuffle still decides within each half. */
function byFlag<T>(xs: readonly T[], flagged: (x: T) => boolean): T[] {
  return [...xs].sort((a, b) => Number(flagged(b)) - Number(flagged(a)));
}

/** Take items round-robin across the lists so no kind is front-loaded. */
function interleave(lists: Selection[][]): Selection[] {
  const out: Selection[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (l[i]) out.push(l[i] as Selection);
  return out;
}

const hasLetters = (s: Selection): boolean => s.letterIds.length > 0;

/** Each item with the one letter it reads (see `oneLetter`). */
async function withLetters(db: D1Database, listener: Listener, since: string, itemIds: string[], slot: Slot): Promise<Selection[]> {
  const readable = await lettersByItem(db, listener.id, since, itemIds);
  return itemIds.map((itemId) => ({ itemId, slot, letterIds: oneLetter(readable.get(itemId)) }));
}

/** The world station: far only, for anyone. No echo: nothing here is the listener's own. The works of the last segments here wait. */
async function worldProgram(db: D1Database, listener: Listener, since: string, size: number, rng: () => number): Promise<Selection[]> {
  const recent = await recentOn(db, listener.id, since, stationColumn({ kind: "world" }));
  const pool = freshestFirst(shuffle(await ids(db, FAR_SQL, listener.id), rng), recent, self).slice(0, size);
  return (await withLetters(db, listener, since, pool, "far")).filter(hasLetters);
}

/**
 * A public radio: the owner's own public letters and the letters they answered with a public 一言, one per segment,
 * the oldest the visitor has not heard first. The works of the visitor's last segments there wait, and the latest
 * one's comes last; a letter heard lately waits behind those not heard. The owner's own letters are the content here,
 * whoever listens. One letter per work, so a longer programme never reads a work twice.
 */
async function publicProgram(db: D1Database, listener: Listener, ownerId: string, since: string, size: number): Promise<Selection[]> {
  const recent = await recentOn(db, listener.id, since, stationColumn({ kind: "public", ownerId }));
  const { results } = await db.prepare(PUBLIC_LETTERS_SQL).bind(listener.id, since, ownerId).all<{ id: string; item_id: string; heard: number; reply_id: string | null }>();
  const wait = (r: { item_id: string; heard: number }) => (recent.latest.has(r.item_id) ? 3 : recent.aired.has(r.item_id) ? 2 : r.heard === 1 ? 1 : 0);
  const out: Selection[] = [];
  const works = new Set<string>();
  for (const r of [...results].sort((a, b) => wait(a) - wait(b))) {
    if (out.length >= size) break;
    if (works.has(r.item_id)) continue;
    works.add(r.item_id);
    out.push({ itemId: r.item_id, slot: "near", letterIds: [r.id], ...(r.reply_id ? { ownerReplyIds: [r.reply_id] } : {}) });
  }
  return out;
}

/** Whether the owner's public radio has a letter to play: the station page says so when it has none. */
export const publicRadioHasLetters = async (db: D1Database, ownerId: string): Promise<boolean> => (await db.prepare(PUBLIC_ANY_SQL).bind(ownerId).first()) !== null;

/**
 * Whether a letter may be asked for by name (a card, a share link, `?letter=`): any public letter, the listener's own
 * too, or a found voice with its source, whether or not it was heard lately. Only what was asked for: the automatic
 * picks keep their own rules (`readable`, the 7-day wait).
 */
export function canAskLetter(l: Letter): boolean {
  const sourced = Boolean(l.sourceUrl?.trim()) && Boolean(l.sourceAuthor?.trim());
  return l.status === "public" && (l.kind === "letter" || (l.kind === "found" && sourced));
}

const heardSince = (): string => new Date(Date.now() - HEARD_WITHIN_MS).toISOString();

/** The letter a listener asked to hear (see `canAskLetter`): its item takes the first seat, reading that letter. Anything else: null. */
async function askedLetter(db: D1Database, letterId: string): Promise<{ itemId: string; letterIds: string[] } | null> {
  const l = await getLetter(db, letterId);
  if (!l || !canAskLetter(l)) return null;
  return { itemId: l.itemId, letterIds: [l.id] };
}

/** A one-seat programme without distances: the dial picks which pool is tried first; the rest follow far, near, neighbor. */
function seatOrder(dial: number): Slot[] {
  const primary: Slot = dial >= 2 / 3 ? "far" : dial >= 1 / 3 ? "neighbor" : "near";
  return [primary, ...(["far", "near", "neighbor"] as const).filter((s) => s !== primary)];
}

/** Candidates scored per pick, drawn at random from the pools, so a large catalogue does not thrash the vector cache. */
const MAX_SCORED = 300;

/**
 * The one seat by distance: among the pool items that have a vector, minus the works whose every letter was heard in the
 * last 7 days and those of the last three segments on this station (the first exclusion is lifted when nothing is left,
 * then the second; the latest segment's work only when it is the only one), the dial's band of the listener's taste. Null when
 * no candidate has a vector: the pools then choose as before. The distance only
 * chooses; it is not returned. The slot (what the bridge says) follows the listener's own pools: a work of their near
 * pool is near however far its vector lies; any other is neighbor below the 2/3 percentile, far above.
 */
async function pickByDistance(db: D1Database, taste: Float32Array, pool: string[], near: ReadonlySet<string>, recent: Recent, dial: number, rng: () => number): Promise<{ id: string; slot: Slot } | null> {
  // During a partial backfill only works that already have a vector can win the distance pick.
  const vecs = await getItemVecs(db, shuffle([...pool].sort(), rng).slice(0, MAX_SCORED));
  if (vecs.size === 0) return null;
  const all = [...vecs.keys()].sort();
  const least = Math.min(...all.map((id) => staleness(recent, id)));
  const cands = all.filter((id) => staleness(recent, id) === least);
  const picked = pickByDial(cands, farness(taste, new Map(cands.map((id) => [id, vecs.get(id) as Float32Array]))), dial, rng);
  if (!picked) return null;
  return { id: picked.id, slot: near.has(picked.id) ? "near" : picked.slot === "far" ? "far" : "neighbor" };
}

export async function selectProgram(
  db: D1Database,
  listener: Listener,
  opts: { size?: number; seed?: string; station?: StationKey; dial?: number; letterId?: string } = {},
): Promise<Selection[]> {
  const size = Math.max(0, Math.floor(opts.size ?? 6));
  const rng = seededRng(opts.seed ?? crypto.randomUUID());
  const since = heardSince();
  if (opts.station?.kind === "world") return worldProgram(db, listener, since, size, rng);
  if (opts.station?.kind === "public") return publicProgram(db, listener, opts.station.ownerId, since, size);
  // The dial the player sends wins over the stored one.
  const dial = Math.min(1, Math.max(0, opts.dial ?? listener.dial));
  const asked = size > 0 && opts.letterId ? await askedLetter(db, opts.letterId) : null;
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
  // At a cold start, the letters from a country the last two segments did not lead with; they are read first.
  let freshPlace: ReadonlySet<string> | null = null;
  const count = () => chosen.near.length + chosen.neighbor.length + chosen.far.length;
  if (room === 1 && !echo) {
    const recent = await recentOn(db, listener.id, since, stationColumn({ kind: "mine" }));
    const { taste, blank } = await standingOf(db, listener);
    const byDistance = taste ? await pickByDistance(db, taste, [...pools.near, ...pools.neighbor, ...pools.far], new Set(raw.near), recent, dial, rng) : null;
    if (byDistance) chosen[byDistance.slot].push(byDistance.id);
    else {
      // Without distances the dial's pool is tried first, but a fresher work of another pool wins over a stale one.
      let seats = seatOrder(dial).flatMap((slot) => pools[slot].map((id) => ({ slot, id })));
      // A cold start (no own letter or reaction, nothing heard, no own work written about): within the same freshness, a work with a
      // letter from another country than the last two segments' goes first, so the dial's far is felt from the start.
      if (blank && raw.near.length === 0 && raw.neighbor.length === 0) {
        const { results } = await db.prepare(FRESH_PLACE_LETTERS_SQL).bind(listener.id).all<{ id: string; item_id: string }>();
        const freshItems = new Set(results.map((r) => r.item_id));
        freshPlace = new Set(results.map((r) => r.id));
        seats = byFlag(seats, (x) => freshItems.has(x.id));
      }
      const seat = freshestFirst(seats, recent, (x) => x.id)[0];
      if (seat) chosen[seat.slot].push(seat.id);
    }
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

  const readable = await lettersByItem(db, listener.id, since, [...chosen.near, ...chosen.neighbor, ...chosen.far]);
  const segments: Record<Slot, Selection[]> = { near: [], neighbor: [], far: [] };
  for (const slot of ["near", "neighbor", "far"] as const) {
    for (const itemId of chosen[slot]) segments[slot].push({ itemId, slot, letterIds: oneLetter(readable.get(itemId), freshPlace) });
  }

  // The asked letter's item sits where the pools put it; an item no pool holds (nobody else wrote yet) counts as near.
  const askedSlot: Slot = asked ? ((["near", "neighbor", "far"] as const).find((s) => raw[s].includes(asked.itemId)) ?? "near") : "near";
  const head = asked ? [{ itemId: asked.itemId, slot: askedSlot, letterIds: asked.letterIds }] : [];
  const first = echo ? segments.near.splice(0, 1) : [];
  // The echo stays even without a letter: the reactions it carries are other people's words, read verbatim.
  return [...head, ...first, ...interleave([segments.near, segments.neighbor, segments.far]).filter(hasLetters)];
}
