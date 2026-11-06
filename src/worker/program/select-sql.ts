/**
 * Candidate pools, one query each. Every query binds the listener id as ?1 and returns
 * distinct `item_id`s ordered by id, so the only randomness is the seeded shuffle afterwards.
 * Nothing here counts or ranks: a pool is a set, not a leaderboard.
 */

const OTHERS_TEXT = "l.status = 'public' AND l.kind IN ('letter', 'reply', 'found')";
const NOT_ME = "(l.listener_id IS NULL OR l.listener_id != ?1)";

const OWN = `own AS (
  SELECT item_id FROM history WHERE listener_id = ?1
  UNION
  SELECT item_id FROM letters WHERE listener_id = ?1 AND status = 'public'
)`;

const NEAR = `SELECT DISTINCT l.item_id FROM letters l
  WHERE l.item_id IN (SELECT item_id FROM own) AND ${OTHERS_TEXT} AND ${NOT_ME}`;

const NEIGHBOR = `SELECT DISTINCT l.item_id FROM letters l
  WHERE l.item_id NOT IN (SELECT item_id FROM own) AND ${OTHERS_TEXT}
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
  WHERE ${OTHERS_TEXT}
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

/** Items whose letter the listener heard since ?2 (an ISO time). */
export const HEARD_RECENTLY_SQL = `SELECT DISTINCT l.item_id FROM listens s JOIN letters l ON l.id = s.letter_id
  WHERE s.listener_id = ?1 AND s.heard_at > ?2`;

/** Items of the listener's last `limit` verified episodes on the station `station` (an SQL expression: a literal or a parameter). */
const episodeItemsSql = (station: string, limit: number): string => `SELECT DISTINCT json_extract(seg.value, '$.itemId') AS item_id FROM
    (SELECT segments FROM episodes WHERE listener_id = ?1 AND station = ${station} AND verified = 1 ORDER BY created_at DESC, id DESC LIMIT ${limit}) e,
    json_each(e.segments) seg
  WHERE json_extract(seg.value, '$.itemId') IS NOT NULL`;

/** Episodes whose works the listener's own station leaves out; the world and public stations leave out fewer. */
export const MINE_RECENT_EPISODES = 30;
export const STATION_RECENT_EPISODES = 10;

/**
 * The listener's own station: works heard since ?2, works of the last 30 episodes there, and the work of the latest one
 * (on air now, or fetched ahead), each row tagged with why.
 */
export const EXCLUDED_SQL = `SELECT item_id, 'heard' AS why FROM (${HEARD_RECENTLY_SQL})
  UNION ALL SELECT item_id, 'aired' AS why FROM (${episodeItemsSql("'mine'", MINE_RECENT_EPISODES)})
  UNION ALL SELECT item_id, 'latest' AS why FROM (${episodeItemsSql("'mine'", 1)})`;

/** The world or a public station (?2 = its `episodes.station` value): works of the listener's last 10 episodes there, and of the latest one. */
export const STATION_EXCLUDED_SQL = `SELECT item_id, 'aired' AS why FROM (${episodeItemsSql("?2", STATION_RECENT_EPISODES)})
  UNION ALL SELECT item_id, 'latest' AS why FROM (${episodeItemsSql("?2", 1)})`;

/** The vectors of up to 50 favourites, in `listFavorites`' order (keep the predicate and ORDER in step). */
export const TASTE_FAVORITES_SQL = `SELECT i.vec FROM
    (SELECT h.item_id FROM history h WHERE h.listener_id = ?1 AND h.source IN ('manual', 'url')
     ORDER BY h.rank IS NULL, h.rank ASC, h.occurred_at DESC, h.item_id LIMIT 50) f
  JOIN items i ON i.id = f.item_id WHERE i.vec IS NOT NULL`;

/** The vectors of up to 20 works whose letters the listener heard most recently. */
export const TASTE_HEARD_SQL = `SELECT i.vec FROM
    (SELECT l.item_id, MAX(s.heard_at) AS at FROM listens s JOIN letters l ON l.id = s.letter_id
     WHERE s.listener_id = ?1 GROUP BY l.item_id ORDER BY at DESC, l.item_id LIMIT 20) h
  JOIN items i ON i.id = h.item_id WHERE i.vec IS NOT NULL`;

/** Letters the DJ may read for the chosen items (?2…): other people's text, never reactions. */
export const letterIdsSql = (items: number): string => `SELECT l.id, l.item_id FROM letters l
  WHERE l.item_id IN (${Array.from({ length: items }, (_, i) => `?${i + 2}`).join(", ")}) AND ${OTHERS_TEXT} AND ${NOT_ME}
  ORDER BY l.item_id, l.id`;

/** A public station's pool (?1 = the owner): the owner's favourites, best-ranked first. Letters are read separately. Keep the predicate and ORDER in step with `listFavorites` in db/history.ts. */
export const OWNER_FAVORITES_SQL = `SELECT h.item_id FROM history h
  WHERE h.listener_id = ?1 AND h.source IN ('manual', 'url')
  ORDER BY h.rank IS NULL, h.rank ASC, h.occurred_at DESC, h.item_id
  LIMIT 200`;
