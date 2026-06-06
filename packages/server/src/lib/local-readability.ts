export function buildVisibleLocalModerationClause(eventAlias = "e"): string {
  return `COALESCE(${eventAlias}.moderation_state, 'visible') != 'hidden'`;
}

export function buildPublicLocalEventReadabilityClause(eventAlias = "e"): string {
  return `${eventAlias}.visibility IN ('public','unlisted') AND ${buildVisibleLocalModerationClause(eventAlias)}`;
}
