import type { DB } from "../db.js";
import { getAttributedActor } from "./federation.js";
import { buildActorUrl, getBaseUrl } from "./base-url.js";

export const AP_RSVP_ACTIVITY_TYPES = ["Accept", "TentativeAccept", "Reject", "Join", "Leave"] as const;
export type ActivityPubRsvpType = (typeof AP_RSVP_ACTIVITY_TYPES)[number];
export type LocalRsvpState = "going" | "maybe" | null;
export type StoredRemoteRsvpState = "going" | "maybe" | "not_going";

const AP_RSVP_TO_LOCAL_STATE: Record<ActivityPubRsvpType, LocalRsvpState> = {
  Accept: "going",
  Join: "going",
  TentativeAccept: "maybe",
  Reject: null,
  Leave: null,
};

const AP_RSVP_PRECEDENCE: Record<ActivityPubRsvpType, number> = {
  Leave: 50,
  Reject: 40,
  TentativeAccept: 30,
  Accept: 20,
  Join: 10,
};

export function isActivityPubRsvpType(type: unknown): type is ActivityPubRsvpType {
  return typeof type === "string" && AP_RSVP_ACTIVITY_TYPES.includes(type as ActivityPubRsvpType);
}

export function mapActivityPubRsvpToLocalState(type: ActivityPubRsvpType): LocalRsvpState {
  return AP_RSVP_TO_LOCAL_STATE[type];
}

export function mapLocalRsvpStateToActivityPubType(status: LocalRsvpState): "Accept" | "TentativeAccept" | "Leave" {
  if (status === "going") return "Accept";
  if (status === "maybe") return "TentativeAccept";
  return "Leave";
}

export function storedRemoteRsvpStateForLocalState(status: LocalRsvpState): StoredRemoteRsvpState {
  return status ?? "not_going";
}

export function rsvpPrecedenceForActivityType(type: ActivityPubRsvpType): number {
  return AP_RSVP_PRECEDENCE[type];
}

export function parseApActorReference(actor: unknown): string | null {
  if (typeof actor === "string") {
    const trimmed = actor.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (actor && typeof actor === "object" && typeof (actor as Record<string, unknown>).id === "string") {
    const trimmed = ((actor as Record<string, unknown>).id as string).trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

export function extractApObjectUri(obj: unknown): string | undefined {
  if (typeof obj === "string") {
    const trimmed = obj.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (obj && typeof obj === "object" && typeof (obj as Record<string, unknown>).id === "string") {
    const trimmed = ((obj as Record<string, unknown>).id as string).trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export function normalizeApPublished(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function normalizeApPublishedWithFallback(published: unknown, updated: unknown): string | null {
  return normalizeApPublished(published) ?? normalizeApPublished(updated);
}

export function localEventIdFromActivityPubUri(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;
  const baseUrl = getBaseUrl();
  const schemeLikePattern = /^[a-z][a-z0-9+.-]*:/i;
  try {
    const parsed = new URL(trimmed);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) return null;
    const basePath = base.pathname.replace(/\/+$/, "");
    const eventPathPrefix = `${basePath}/events/`;
    if (!parsed.pathname.startsWith(eventPathPrefix)) return null;
    const eventPathRemainder = parsed.pathname.slice(eventPathPrefix.length);
    const match = eventPathRemainder.match(/^([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return schemeLikePattern.test(trimmed) ? null : trimmed;
  }
}

type LocalRsvpEventTarget = { eventId: string; ownerActorUri: string };

export function resolveLocalRsvpEventTarget(
  db: DB,
  activity: Record<string, unknown>,
  options: { inboxUsername?: string } = {},
): LocalRsvpEventTarget | null {
  const rawObject = activity.object;
  const objectUri = extractApObjectUri(rawObject);
  if (!objectUri) return null;

  if (rawObject && typeof rawObject === "object") {
    const object = rawObject as Record<string, unknown>;
    if (typeof object.type === "string" && object.type !== "Event") return null;

    const innerActor = parseApActorReference(object.actor);
    const activityActor = parseApActorReference(activity.actor);
    if (innerActor && activityActor && innerActor !== activityActor) return null;

    const embeddedAttributedTo = getAttributedActor(object);
    if (embeddedAttributedTo.status === "unparseable") return null;
  }

  const eventId = localEventIdFromActivityPubUri(objectUri);
  if (!eventId) return null;

  const localEvent = db.prepare(
    `SELECT e.id, a.username
     FROM events e
     JOIN accounts a ON a.id = e.account_id
     WHERE e.id = ?`,
  ).get(eventId) as { id: string; username: string } | undefined;
  if (!localEvent) return null;

  if (options.inboxUsername && localEvent.username !== options.inboxUsername) return null;

  const ownerActorUri = buildActorUrl(localEvent.username);
  if (rawObject && typeof rawObject === "object") {
    const attributedTo = getAttributedActor(rawObject as Record<string, unknown>);
    if (attributedTo.status === "parsed" && attributedTo.actor !== ownerActorUri) return null;
  }

  return { eventId, ownerActorUri };
}

export function shouldApplyRemoteRsvpUpdate(existing: {
  last_activity_published_at: string | null;
  last_activity_precedence: number | null;
} | undefined, incoming: { publishedAt: string | null; precedence: number }): boolean {
  if (!existing) return true;
  const existingPublished = existing.last_activity_published_at;
  if (incoming.publishedAt && existingPublished) {
    const incomingMs = Date.parse(incoming.publishedAt);
    const existingMs = Date.parse(existingPublished);
    if (Number.isFinite(incomingMs) && Number.isFinite(existingMs) && incomingMs !== existingMs) {
      return incomingMs > existingMs;
    }
  } else if (incoming.publishedAt && !existingPublished) {
    return true;
  }

  return incoming.precedence > (existing.last_activity_precedence ?? 0);
}

export function upsertRemoteEventRsvp(
  db: DB,
  params: {
    eventId: string;
    actorUri: string;
    activityType: ActivityPubRsvpType;
    activityId: string | null;
    publishedAt: string | null;
    localState: LocalRsvpState;
  },
): { applied: boolean; status: StoredRemoteRsvpState } {
  const status = storedRemoteRsvpStateForLocalState(params.localState);
  const precedence = rsvpPrecedenceForActivityType(params.activityType);
  const existing = db.prepare(
    `SELECT last_activity_published_at, last_activity_precedence
     FROM remote_event_rsvps
     WHERE event_id = ? AND actor_uri = ?`,
  ).get(params.eventId, params.actorUri) as
    | { last_activity_published_at: string | null; last_activity_precedence: number | null }
    | undefined;

  if (!shouldApplyRemoteRsvpUpdate(existing, { publishedAt: params.publishedAt, precedence })) {
    return { applied: false, status };
  }

  db.prepare(
    `INSERT INTO remote_event_rsvps (
       event_id, actor_uri, status, last_activity_id, last_activity_type,
       last_activity_published_at, last_activity_precedence, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(event_id, actor_uri) DO UPDATE SET
       status = excluded.status,
       last_activity_id = excluded.last_activity_id,
       last_activity_type = excluded.last_activity_type,
       last_activity_published_at = excluded.last_activity_published_at,
       last_activity_precedence = excluded.last_activity_precedence,
       updated_at = datetime('now')`,
  ).run(
    params.eventId,
    params.actorUri,
    status,
    params.activityId,
    params.activityType,
    params.publishedAt,
    precedence,
  );

  return { applied: true, status };
}
