export function buildPublicEventsCountSubquery(): string {
  return `(SELECT COUNT(*) FROM (
      SELECT e.id FROM events e WHERE e.account_id = accounts.id AND e.visibility IN ('public','unlisted')
      UNION
      SELECT r.event_id FROM reposts r JOIN events e ON e.id = r.event_id WHERE r.account_id = accounts.id AND e.visibility IN ('public','unlisted')
      UNION
      SELECT e.id FROM auto_reposts ar JOIN events e ON e.account_id = ar.source_account_id WHERE ar.account_id = accounts.id AND e.visibility = 'public'
      UNION
      SELECT re.uri FROM reposts r JOIN remote_events re ON re.uri = r.event_uri WHERE r.account_id = accounts.id AND re.visibility IN ('public','unlisted')
      UNION
      SELECT re.uri FROM auto_reposts ar JOIN remote_events re ON re.actor_uri = ar.source_actor_uri WHERE ar.account_id = accounts.id AND re.visibility = 'public'
    ))`;
}
