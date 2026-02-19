/**
 * Builds the SQL and params for the "feed" scope (events from accounts you follow,
 * including reposts and auto-reposts with labels).
 *
 * Returns a subquery that can be wrapped with additional filters. Use
 * SELECT combined.* to avoid column conflicts when joining accounts.
 */

const FOLLOW_LIST = `(SELECT following_id FROM follows WHERE follower_id = ?)`;

function remoteFollowLocal(baseUrl: string): string {
  return `(SELECT a2.id FROM accounts a2 WHERE ? || '/users/' || a2.username IN (SELECT actor_uri FROM remote_following WHERE account_id = ?))`;
}

// Column lists for UNION (first branch sets names via AS, others match by position)
const COLS_BRANCH1 = `e.*, a.username AS account_username, a.display_name AS account_display_name,
       GROUP_CONCAT(DISTINCT t.tag) AS tags, NULL AS repost_username, NULL AS repost_display_name`;
const COLS_OTHER = `e.*, a.username, a.display_name, GROUP_CONCAT(DISTINCT t.tag), NULL, NULL`;
const COLS_REPOST = `e.*, a.username, a.display_name, GROUP_CONCAT(DISTINCT t.tag), ra.username, ra.display_name`;

const EVENTS_JOIN = `FROM events e
    JOIN accounts a ON a.id = e.account_id
    LEFT JOIN event_tags t ON t.event_id = e.id`;

export interface FeedQueryOptions {
  userId: string;
  baseUrl: string;
  /** When set, each branch gets "e.start_date >= ? AND " prepended (for timeline) */
  dateFrom?: string;
}

export interface FeedQueryResult {
  /** SQL for the UNION subquery + "AS combined JOIN accounts a ... WHERE 1=1" */
  sql: string;
  /** Params for the placeholders in the subquery */
  params: unknown[];
}

/**
 * Build feed query: own events + direct follows + remote_following local +
 * RSVP'd + explicit reposts + auto-reposts. Repost branches exclude events
 * where we already follow the creator (to avoid duplicates, and to show
 * repost label only when that's why we see the event).
 */
export function buildFeedQuery(opts: FeedQueryOptions): FeedQueryResult {
  const { userId, baseUrl, dateFrom } = opts;
  const rfl = remoteFollowLocal(baseUrl);
  const datePrefix = dateFrom ? "e.start_date >= ? AND " : "";

  const params: unknown[] = [];

  function push(...vals: unknown[]) {
    params.push(...vals);
  }

  // Branch 1: Own events
  const b1Where = `${datePrefix}e.account_id = ? AND e.visibility IN ('public','unlisted','followers_only','private')`;
  if (dateFrom) push(dateFrom);
  push(userId);

  // Branch 2: Direct follows
  const b2Where = `${datePrefix}e.account_id IN ${FOLLOW_LIST} AND e.visibility IN ('public','unlisted','followers_only')`;
  if (dateFrom) push(dateFrom);
  push(userId);

  // Branch 3: Local accounts we follow via remote_following (Federation)
  const b3Where = `${datePrefix}e.account_id IN ${rfl} AND e.visibility IN ('public','unlisted','followers_only')`;
  if (dateFrom) push(dateFrom);
  push(baseUrl, userId);

  // Branch 4: Events we've RSVP'd to
  const b4Where = `${datePrefix}e.id IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?) AND e.visibility IN ('public','unlisted')`;
  if (dateFrom) push(dateFrom);
  push(userId);

  // Branch 5: Explicit reposts (only when creator not followed)
  const b5Where = `${datePrefix}(r.account_id IN ${FOLLOW_LIST} OR r.account_id IN ${rfl})
      AND e.visibility IN ('public','unlisted')
      AND e.account_id != ? AND e.account_id NOT IN ${FOLLOW_LIST} AND e.account_id NOT IN ${rfl}`;
  if (dateFrom) push(dateFrom);
  push(userId, baseUrl, userId, userId, userId, baseUrl, userId);

  // Branch 6: Auto-reposts (only when creator not followed)
  const b6Where = `${datePrefix}(ar.account_id IN ${FOLLOW_LIST} OR ar.account_id IN ${rfl})
      AND e.visibility = 'public'
      AND e.account_id != ? AND e.account_id NOT IN ${FOLLOW_LIST} AND e.account_id NOT IN ${rfl}
      AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ar.account_id)`;
  if (dateFrom) push(dateFrom);
  push(userId, baseUrl, userId, userId, userId, baseUrl, userId);

  const sql = `
    SELECT ${COLS_BRANCH1}
    ${EVENTS_JOIN}
    WHERE ${b1Where}
    GROUP BY e.id
    UNION ALL
    SELECT ${COLS_OTHER}
    ${EVENTS_JOIN}
    WHERE ${b2Where}
    GROUP BY e.id
    UNION ALL
    SELECT ${COLS_OTHER}
    ${EVENTS_JOIN}
    WHERE ${b3Where}
    GROUP BY e.id
    UNION ALL
    SELECT ${COLS_OTHER}
    ${EVENTS_JOIN}
    WHERE ${b4Where}
    GROUP BY e.id
    UNION ALL
    SELECT ${COLS_REPOST}
    FROM reposts r
    JOIN events e ON e.id = r.event_id
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts ra ON ra.id = r.account_id
    LEFT JOIN event_tags t ON t.event_id = e.id
    WHERE ${b5Where}
    GROUP BY e.id
    UNION ALL
    SELECT ${COLS_REPOST}
    FROM auto_reposts ar
    JOIN events e ON e.account_id = ar.source_account_id
    JOIN accounts a ON a.id = e.account_id
    JOIN accounts ra ON ra.id = ar.account_id
    LEFT JOIN event_tags t ON t.event_id = e.id
    WHERE ${b6Where}
    GROUP BY e.id
  `;

  return {
    sql: `SELECT combined.* FROM (${sql.trim()}) AS combined
  JOIN accounts a ON a.id = combined.account_id
  WHERE 1=1`,
    params,
  };
}
