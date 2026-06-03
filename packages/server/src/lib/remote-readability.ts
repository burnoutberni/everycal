export function buildRemoteReadabilityFilter(
  currentUserId?: string,
  options: { eventAlias?: string } = {},
): { sql: string; params: unknown[] } {
  const eventAlias = options.eventAlias || "re";
  const moderationSql = `COALESCE(${eventAlias}.moderation_state, 'visible') != 'hidden'`;
  if (!currentUserId) {
    return {
      sql: `(${moderationSql} AND ${eventAlias}.visibility IN ('public','unlisted'))`,
      params: [],
    };
  }
  return {
    sql: `(
      ${moderationSql}
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
