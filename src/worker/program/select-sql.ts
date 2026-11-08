import { OWN_VOICES_SQL } from "../db/letters";

/**
 * Candidate pools, one query each. Every query binds the listener id as ?1 and returns
 * distinct `item_id`s ordered by id, so the only randomness is the seeded shuffle afterwards.
 * Nothing here counts or ranks: a pool is a set, not a leaderboard.
 */

/** A letter, or a found voice with both its link and its author. */
const letterOrSourced = (a: string): string =>
  `(${a}.kind = 'letter' OR (${a}.kind = 'found' AND TRIM(COALESCE(${a}.source_url, '')) != '' AND TRIM(COALESCE(${a}.source_author, '')) != ''))`;

/**
 * A letter the DJ may read to the listener (?1) as a segment's one letter: someone else's public letter, or a found
 * voice with its source (a segment with a sourceless one would have nothing to read). A 一言 or a 私も is never a
 * segment's letter: it airs as a reaction in the echo. `a` is the table alias.
 */
const readable = (a: string): string => `${a}.status = 'public' AND ${letterOrSourced(a)} AND (${a}.listener_id IS NULL OR ${a}.listener_id != ?1)`;

const OWN = `own AS (
  SELECT item_id FROM history WHERE listener_id = ?1
  UNION
  SELECT item_id FROM letters WHERE listener_id = ?1 AND status = 'public'
)`;

const NEAR = `SELECT DISTINCT l.item_id FROM letters l
  WHERE l.item_id IN (SELECT item_id FROM own) AND ${readable("l")}`;

const NEIGHBOR = `SELECT DISTINCT l.item_id FROM letters l
  WHERE l.item_id NOT IN (SELECT item_id FROM own) AND ${readable("l")}
    AND (
      l.listener_id IN (
        SELECT n.listener_id FROM letters n
        WHERE n.item_id IN (SELECT item_id FROM own) AND n.status = 'public'
          AND n.kind IN ('letter', 'reply', 'found') AND n.listener_id IS NOT NULL AND n.listener_id != ?1)
      OR l.source_author IN (
        SELECT n.source_author FROM letters n
        WHERE n.item_id IN (SELECT item_id FROM own) AND n.status = 'public'
          AND n.kind IN ('letter', 'reply', 'found') AND n.source_author IS NOT NULL)
    )`;

export const NEAR_SQL = `WITH ${OWN} ${NEAR} ORDER BY item_id`;
export const NEIGHBOR_SQL = `WITH ${OWN} ${NEIGHBOR} ORDER BY item_id`;

export const FAR_SQL = `WITH ${OWN},
  near AS (${NEAR}),
  neighbor AS (${NEIGHBOR})
  SELECT DISTINCT l.item_id FROM letters l
  WHERE ${readable("l")}
    AND l.item_id NOT IN (SELECT item_id FROM own)
    AND l.item_id NOT IN (SELECT item_id FROM near)
    AND l.item_id NOT IN (SELECT item_id FROM neighbor)
  ORDER BY l.item_id`;

/** Item ids of the listener's latest `mine` episode (one-seat episodes: the one airing, or the one fetched ahead). */
const LATEST_MINE_ITEMS = `SELECT json_extract(seg.value, '$.itemId') FROM
    (SELECT segments FROM episodes WHERE listener_id = ?1 AND station = 'mine' ORDER BY created_at DESC, id DESC LIMIT 1) e,
    json_each(e.segments) seg
  WHERE json_extract(seg.value, '$.itemId') IS NOT NULL`;

/**
 * Own items whose letter got a reaction from someone else since the listener last heard a letter on their own station
 * (what they heard, not what was made: an episode fetched ahead and dropped does not use the reaction up); none before
 * the first. The item of the latest episode is left out, so the episode fetched ahead does not repeat it.
 */
export const ECHO_SQL = `SELECT DISTINCT r.item_id FROM letters r
  JOIN letters p ON p.id = r.parent_letter_id
  WHERE p.listener_id = ?1 AND p.status = 'public' AND r.status = 'public' AND r.kind IN ('watashimo', 'reply')
    AND (r.listener_id IS NULL OR r.listener_id != ?1)
    AND r.created_at > (SELECT MAX(s.heard_at) FROM listens s JOIN episodes e ON e.id = s.episode_id WHERE s.listener_id = ?1 AND e.station = 'mine')
    AND r.item_id NOT IN (${LATEST_MINE_ITEMS})
  ORDER BY r.item_id`;

/** Letters the listener heard since ?2 (an ISO time), on any station. */
const HEARD_LETTERS = "SELECT s.letter_id FROM listens s WHERE s.listener_id = ?1 AND s.heard_at > ?2";

/** Works with nothing left to hear: a letter of theirs was heard since ?2, and every letter the DJ may read was. */
const SPENT_ITEMS = `SELECT DISTINCT l.item_id FROM letters l
  WHERE l.id IN (${HEARD_LETTERS})
    AND NOT EXISTS (SELECT 1 FROM letters o WHERE o.item_id = l.item_id AND ${readable("o")} AND o.id NOT IN (${HEARD_LETTERS}))`;

/** Segments whose works wait: the same work never airs within three segments of itself. */
export const RECENT_SEGMENTS = 3;

/** Works of the listener's last `n` segments on the station ?3 (verified episodes; an episode is one segment, the eval's more). */
const lastSegmentItems = (n: number): string => `SELECT json_extract(seg.value, '$.itemId') AS item_id FROM
    (SELECT segments, created_at, id FROM episodes WHERE listener_id = ?1 AND station = ?3 AND verified = 1 ORDER BY created_at DESC, id DESC LIMIT ${n}) e,
    json_each(e.segments) seg
  WHERE json_extract(seg.value, '$.itemId') IS NOT NULL
  ORDER BY e.created_at DESC, e.id DESC, seg.key DESC
  LIMIT ${n}`;

/**
 * What waits on the station ?3 (its `episodes.station` value) for the listener ?1, each row tagged with why: works
 * whose every readable letter was heard since ?2 (`spent`), works of the last three segments there (`aired`), and the
 * work of the latest one (`latest`: on air now, or fetched ahead).
 */
export const EXCLUDED_SQL = `SELECT item_id, 'spent' AS why FROM (${SPENT_ITEMS})
  UNION ALL SELECT item_id, 'aired' AS why FROM (${lastSegmentItems(RECENT_SEGMENTS)})
  UNION ALL SELECT item_id, 'latest' AS why FROM (${lastSegmentItems(1)})`;

/**
 * The vectors of the listener's 50 most recent own voices (`OWN_VOICES_SQL`: their own letters, and the letters they
 * answered with a 私も or a 一言): the letter's own vector (its work and its text), else its work's (`vec_mix`, else `vec`);
 * null when neither has one. Favourites never count.
 */
export const TASTE_OWN_SQL = `SELECT COALESCE(v.vec, i.vec_mix, i.vec) AS vec FROM
    (SELECT v.item_id, v.created_at, v.vec FROM (${OWN_VOICES_SQL}) v ORDER BY v.created_at DESC, v.item_id LIMIT 50) v
  JOIN items i ON i.id = v.item_id`;

/**
 * The vectors of the 20 letters the listener heard most recently: the letter's own while it is public, else its work's
 * (`vec_mix`, else `vec`); null when neither has one.
 */
export const TASTE_HEARD_SQL = `SELECT COALESCE(CASE WHEN l.status = 'public' THEN l.vec END, i.vec_mix, i.vec) AS vec FROM
    (SELECT s.letter_id, MAX(s.heard_at) AS at FROM listens s WHERE s.listener_id = ?1 GROUP BY s.letter_id ORDER BY at DESC, s.letter_id LIMIT 20) h
  JOIN letters l ON l.id = h.letter_id
  JOIN items i ON i.id = l.item_id`;

/**
 * Letters the DJ may read for the chosen items (?3…), with whether the listener heard each since ?2: per item, the
 * unheard first, the oldest first. Other people's letters and found voices, never reactions.
 */
export const letterIdsSql = (items: number): string => `SELECT l.id, l.item_id, (l.id IN (${HEARD_LETTERS})) AS heard FROM letters l
  WHERE l.item_id IN (${Array.from({ length: items }, (_, i) => `?${i + 3}`).join(", ")}) AND ${readable("l")}
  ORDER BY l.item_id, heard, l.created_at, l.id`;

/**
 * A public radio's letters (`owner` = the owner's parameter): the owner's own public letters, and the public letters
 * the owner left a public 一言 on. Never their favourites, never anything withdrawn or rejected.
 */
const publicPool = (owner: string): string => `l.status = 'public' AND (
    (l.listener_id = ${owner} AND l.kind = 'letter')
    OR (${letterOrSourced("l")} AND l.id IN (SELECT r.parent_letter_id FROM letters r WHERE r.listener_id = ${owner} AND r.kind = 'reply' AND r.status = 'public'))
  )`;

/**
 * The public radio of ?3 for the visitor ?1, with whether they heard each letter since ?2 (the unheard first, the oldest
 * first) and the owner's latest public 一言 on it, read after it (null on the owner's own letters).
 */
export const PUBLIC_LETTERS_SQL = `SELECT l.id, l.item_id, (l.id IN (${HEARD_LETTERS})) AS heard,
    (SELECT r.id FROM letters r WHERE r.parent_letter_id = l.id AND r.listener_id = ?3 AND r.kind = 'reply' AND r.status = 'public'
     ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS reply_id
  FROM letters l
  WHERE ${publicPool("?3")}
  ORDER BY heard, l.created_at, l.id`;

/** Whether the public radio of ?1 has a letter to play. */
export const PUBLIC_ANY_SQL = `SELECT 1 AS found FROM letters l WHERE ${publicPool("?1")} LIMIT 1`;

/** The letter read first in each of the listener's last two segments on their own station (verified episodes, newest first). */
const LAST_TWO_LEADS = `SELECT (SELECT json_extract(ln.value, '$.letterId') FROM json_each(seg.value, '$.lines') ln
      WHERE json_extract(ln.value, '$.type') = 'letter' ORDER BY ln.key LIMIT 1) AS letter_id
  FROM (SELECT segments, created_at, id FROM episodes WHERE listener_id = ?1 AND station = 'mine' AND verified = 1 ORDER BY created_at DESC, id DESC LIMIT 2) e,
    json_each(e.segments) seg
  ORDER BY e.created_at DESC, e.id DESC, seg.key DESC
  LIMIT 2`;

/**
 * A cold start (no taste yet): the letters the DJ may read (as `letterIdsSql`) whose sender's country is not one of
 * those the listener's last two segments led with. A letter without a country code (older rows) is never left out.
 * Only chooses: no country, distance or count leaves the selector.
 */
export const FRESH_PLACE_LETTERS_SQL = `WITH recent AS (
    SELECT l.place_country FROM (${LAST_TWO_LEADS}) r JOIN letters l ON l.id = r.letter_id WHERE l.place_country IS NOT NULL
  )
  SELECT l.id, l.item_id FROM letters l
  WHERE ${readable("l")}
    AND (l.place_country IS NULL OR l.place_country NOT IN (SELECT place_country FROM recent))
  ORDER BY l.item_id, l.id`;
