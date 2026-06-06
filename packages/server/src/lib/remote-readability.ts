import { buildActiveFederationBlockFilter } from "./federation-blocks.js";
import { buildActiveFederationTombstoneFilter } from "./federation-tombstones.js";

export function buildRemoteReadabilityFilter(
  currentUserId?: string,
  options: { eventAlias?: string; actorDomainSql?: string } = {},
): { sql: string; params: unknown[] } {
  const eventAlias = options.eventAlias || "re";
  const moderationSql = `COALESCE(${eventAlias}.moderation_state, 'visible') != 'hidden'`;
  const blockSql = buildActiveFederationBlockFilter({ eventAlias, actorDomainSql: options.actorDomainSql });
  const tombstoneSql = buildActiveFederationTombstoneFilter({ eventAlias, actorUriSql: `${eventAlias}.actor_uri` });
  if (!currentUserId) {
    return {
      sql: `(${moderationSql} AND ${blockSql} AND ${tombstoneSql} AND ${eventAlias}.visibility IN ('public','unlisted'))`,
      params: [],
    };
  }
  return {
    sql: `(
      ${moderationSql}
      AND ${blockSql}
      AND ${tombstoneSql}
      AND (
        ${eventAlias}.visibility IN ('public','unlisted')
        OR (
          ${eventAlias}.visibility = 'followers_only'
          AND ${eventAlias}.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
        )
      )
    )`,
    params: [currentUserId],
  };
}
