import type { DB } from "../db.js";
import { buildPublicLocalEventReadabilityClause, buildVisibleLocalModerationClause } from "./local-readability.js";
import { buildRemoteReadabilityFilter } from "./remote-readability.js";

export function buildPublicEventsCountSubquery(): string {
  const remoteReadability = buildRemoteReadabilityFilter(undefined, { eventAlias: "re" });
  const localReadability = buildPublicLocalEventReadabilityClause("e");
  const localPublicModeration = buildVisibleLocalModerationClause("e");
  return `(SELECT COUNT(*) FROM (
      SELECT e.id FROM events e WHERE e.account_id = accounts.id AND ${localReadability}
      UNION
      SELECT r.event_id FROM reposts r JOIN events e ON e.id = r.event_id WHERE r.account_id = accounts.id AND ${localReadability}
      UNION
      SELECT e.id FROM auto_reposts ar JOIN events e ON e.account_id = ar.source_account_id WHERE ar.account_id = accounts.id AND e.visibility = 'public' AND ${localPublicModeration}
      UNION
      SELECT re.uri FROM reposts r JOIN remote_events re ON re.uri = r.event_uri WHERE r.account_id = accounts.id AND ${remoteReadability.sql}
      UNION
      SELECT re.uri FROM auto_reposts ar JOIN remote_events re ON re.actor_uri = ar.source_actor_uri WHERE ar.account_id = accounts.id AND ${remoteReadability.sql}
    ))`;
}

export function loadPublicEventsCountsByAccountId(db: DB, accountIds: string[]): Map<string, number> {
  if (accountIds.length === 0) return new Map();

  const remoteReadability = buildRemoteReadabilityFilter(undefined, { eventAlias: "re" });
  const localReadability = buildPublicLocalEventReadabilityClause("e");
  const localPublicModeration = buildVisibleLocalModerationClause("e");
  const placeholders = accountIds.map(() => "(?)").join(", ");
  const sql = `
    WITH target_accounts(id) AS (VALUES ${placeholders}),
    visible_items AS (
      SELECT e.account_id AS account_id, e.id AS item_id
      FROM events e
      JOIN target_accounts ta ON ta.id = e.account_id
      WHERE ${localReadability}
      UNION
      SELECT r.account_id AS account_id, r.event_id AS item_id
      FROM reposts r
      JOIN events e ON e.id = r.event_id
      JOIN target_accounts ta ON ta.id = r.account_id
      WHERE ${localReadability}
      UNION
      SELECT ar.account_id AS account_id, e.id AS item_id
      FROM auto_reposts ar
      JOIN events e ON e.account_id = ar.source_account_id
      JOIN target_accounts ta ON ta.id = ar.account_id
      WHERE e.visibility = 'public' AND ${localPublicModeration}
      UNION
      SELECT r.account_id AS account_id, re.uri AS item_id
      FROM reposts r
      JOIN remote_events re ON re.uri = r.event_uri
      JOIN target_accounts ta ON ta.id = r.account_id
      WHERE ${remoteReadability.sql}
      UNION
      SELECT ar.account_id AS account_id, re.uri AS item_id
      FROM auto_reposts ar
      JOIN remote_events re ON re.actor_uri = ar.source_actor_uri
      JOIN target_accounts ta ON ta.id = ar.account_id
      WHERE ${remoteReadability.sql}
    )
    SELECT account_id, COUNT(*) AS events_count
    FROM visible_items
    GROUP BY account_id
  `;

  const rows = db.prepare(sql).all(...accountIds, ...remoteReadability.params, ...remoteReadability.params) as Array<{ account_id: string; events_count: number }>;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.account_id, row.events_count ?? 0);
  return counts;
}
