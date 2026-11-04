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

/**
 * Own items nobody else has written about (the listener's own letter does not count, since it is never read
 * back to them): the DJ introduces them from the work's data alone.
 */
export const FALLBACK_SQL = `WITH ${OWN}
  SELECT o.item_id FROM own o
  WHERE NOT EXISTS (SELECT 1 FROM letters l WHERE l.item_id = o.item_id AND ${OTHERS_TEXT} AND ${NOT_ME})
  ORDER BY o.item_id`;

/** Own items whose letter got a reaction from someone else since the listener's last episode; none before the first. */
export const ECHO_SQL = `SELECT DISTINCT r.item_id FROM letters r
  JOIN letters p ON p.id = r.parent_letter_id
  WHERE p.listener_id = ?1 AND p.status = 'public' AND r.status = 'public' AND r.kind IN ('watashimo', 'reply')
    AND (r.listener_id IS NULL OR r.listener_id != ?1)
    AND r.created_at > (SELECT MAX(created_at) FROM episodes WHERE listener_id = ?1)
  ORDER BY r.item_id`;

/** Letters the DJ may read for the chosen items (?2…): other people's text, never reactions. */
export const letterIdsSql = (items: number): string => `SELECT l.id, l.item_id FROM letters l
  WHERE l.item_id IN (${Array.from({ length: items }, (_, i) => `?${i + 2}`).join(", ")}) AND ${OTHERS_TEXT} AND ${NOT_ME}
  ORDER BY l.item_id, l.id`;
