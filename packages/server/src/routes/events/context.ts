import type { DB } from "../../db.js";
import { canViewEvent, formatEvent, LOCAL_EVENT_SELECT } from "./shared.js";

export function createEventRouteContext(db: DB) {
  // ─── DB query helpers (closed over `db`) ────────────────────────────────

  function getUserRsvps(userId: string, eventUris: string[]): Map<string, string> {
    if (eventUris.length === 0) return new Map();
    const placeholders = eventUris.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT event_uri, status FROM event_rsvps WHERE account_id = ? AND event_uri IN (${placeholders})`)
      .all(userId, ...eventUris) as { event_uri: string; status: string }[];
    return new Map(rows.map((r) => [r.event_uri, r.status]));
  }

  function getUserReposts(userId: string, eventIds: string[]): Set<string> {
    if (eventIds.length === 0) return new Set();
    const placeholders = eventIds.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT event_id FROM reposts WHERE account_id = ? AND event_id IN (${placeholders})`)
      .all(userId, ...eventIds) as { event_id: string }[];
    return new Set(rows.map((r) => r.event_id));
  }

  /** Attach rsvpStatus + reposted flags to a list of events for the logged-in user. */
  function attachUserContext(events: Record<string, unknown>[], userId: string): Record<string, unknown>[] {
    const ids = events.map((e) => e.id as string);
    const rsvps = getUserRsvps(userId, ids);
    const reposts = getUserReposts(userId, ids);
    return events.map((e) => ({
      ...e,
      rsvpStatus: rsvps.get(e.id as string) || null,
      reposted: reposts.has(e.id as string),
    }));
  }

  /** Attach rsvpStatus + reposted to a single formatted event (mutates in place). */
  function attachSingleEventContext(event: Record<string, unknown>, eventId: string, userId: string): void {
    const rsvpRow = db
      .prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
      .get(userId, eventId) as { status: string } | undefined;
    event.rsvpStatus = rsvpRow?.status || null;
    const repostRow = db.prepare("SELECT 1 FROM reposts WHERE account_id = ? AND event_id = ?").get(userId, eventId);
    event.reposted = !!repostRow;
  }

  /** Query a local event by ID — format only, no visibility check (for read-back after create/update). */
  function readLocalEventById(eventId: string): Record<string, unknown> | null {
    const row = db
      .prepare(`${LOCAL_EVENT_SELECT} WHERE e.id = ? GROUP BY e.id`)
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return formatEvent(row);
  }

  /**
   * Fetch a single local event with visibility check and user context.
   * Returns null when not found or the user lacks permission.
   */
  function fetchLocalEvent(
    whereClause: string,
    queryParams: unknown[],
    currentUser?: { id: string } | null,
  ): Record<string, unknown> | null {
    const row = db
      .prepare(`${LOCAL_EVENT_SELECT} WHERE ${whereClause} GROUP BY e.id`)
      .get(...queryParams) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (!canViewEvent(db, row.visibility as string, row.account_id as string, currentUser)) return null;

    const event = formatEvent(row);
    if (currentUser) attachSingleEventContext(event, row.id as string, currentUser.id);
    return event;
  }

  /** Insert tags for an event. */
  function saveTags(eventId: string, tags: string[]): void {
    const stmt = db.prepare("INSERT OR IGNORE INTO event_tags (event_id, tag) VALUES (?, ?)");
    for (const tag of tags) {
      const trimmed = tag.trim();
      if (!trimmed) continue;
      stmt.run(eventId, trimmed);
    }
  }

  /** Delete then re-insert tags for an event. */
  function replaceTags(eventId: string, tags: string[]): void {
    db.prepare("DELETE FROM event_tags WHERE event_id = ?").run(eventId);
    saveTags(eventId, tags);
  }

  return {
    getUserRsvps,
    getUserReposts,
    attachUserContext,
    attachSingleEventContext,
    readLocalEventById,
    fetchLocalEvent,
    saveTags,
    replaceTags,
  };
}

export type EventRouteContext = ReturnType<typeof createEventRouteContext>;
