import type { DB } from "../db.js";

const ACTIVE_TOMBSTONE_SQL = "(ft.expires_at IS NULL OR ft.expires_at > datetime('now'))";
const ACTOR_TOMBSTONE_TYPE_SQL = "'remote_actor', 'actor'";
const EVENT_TOMBSTONE_TYPE_SQL = "'remote_event', 'event'";
const ACTIVITY_TOMBSTONE_TYPE_SQL = "'activity'";

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function isRemoteActorTombstoned(db: DB, actorUri: string | null | undefined): boolean {
  const normalizedActorUri = normalizeId(actorUri);
  if (!normalizedActorUri) return false;
  const row = db.prepare(
    `SELECT 1
     FROM federation_tombstones ft
     WHERE ft.object_type IN (${ACTOR_TOMBSTONE_TYPE_SQL})
       AND ft.object_id = ?
       AND ${ACTIVE_TOMBSTONE_SQL}
     LIMIT 1`
  ).get(normalizedActorUri);
  return !!row;
}

export function isRemoteEventTombstoned(db: DB, eventUri: string | null | undefined): boolean {
  const normalizedEventUri = normalizeId(eventUri);
  if (!normalizedEventUri) return false;
  const row = db.prepare(
    `SELECT 1
     FROM federation_tombstones ft
     WHERE ft.object_type IN (${EVENT_TOMBSTONE_TYPE_SQL})
       AND ft.object_id = ?
       AND ${ACTIVE_TOMBSTONE_SQL}
     LIMIT 1`
  ).get(normalizedEventUri);
  return !!row;
}

export function isActivityTombstoned(db: DB, activityId: string | null | undefined): boolean {
  const normalizedActivityId = normalizeId(activityId);
  if (!normalizedActivityId) return false;
  const row = db.prepare(
    `SELECT 1
     FROM federation_tombstones ft
     WHERE ft.object_type IN (${ACTIVITY_TOMBSTONE_TYPE_SQL})
       AND ft.object_id = ?
       AND ${ACTIVE_TOMBSTONE_SQL}
     LIMIT 1`
  ).get(normalizedActivityId);
  return !!row;
}

export function buildActiveFederationActorTombstoneFilter(actorAlias = "ra"): string {
  return `NOT EXISTS (
    SELECT 1
    FROM federation_tombstones ft
    WHERE ft.object_type IN (${ACTOR_TOMBSTONE_TYPE_SQL})
      AND ft.object_id = ${actorAlias}.uri
      AND ${ACTIVE_TOMBSTONE_SQL}
  )`;
}

export function buildActiveFederationTombstoneFilter(
  options: { eventAlias?: string; actorUriSql?: string } = {},
): string {
  const eventAlias = options.eventAlias || "re";
  const actorUriSql = options.actorUriSql || `${eventAlias}.actor_uri`;
  return `NOT EXISTS (
    SELECT 1
    FROM federation_tombstones ft
    WHERE ${ACTIVE_TOMBSTONE_SQL}
      AND (
        (ft.object_type IN (${EVENT_TOMBSTONE_TYPE_SQL}) AND ft.object_id = ${eventAlias}.uri)
        OR (ft.object_type IN (${ACTOR_TOMBSTONE_TYPE_SQL}) AND ft.object_id = ${actorUriSql})
      )
  )`;
}
