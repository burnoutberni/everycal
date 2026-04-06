/**
 * Event API routes.
 *
 * GET  /api/v1/events                — list public events
 * GET  /api/v1/events/timeline       — legacy: events from people you follow
 * GET  /api/v1/events/:id            — single event
 * POST /api/v1/events                — create event (auth)
 * POST /api/v1/events/rsvp           — set RSVP status for an event (auth)
 * POST /api/v1/events/sync           — sync events for scraper accounts (auth)
 * PUT  /api/v1/events/:id            — update event (auth, owner only)
 * DELETE /api/v1/events/:id          — delete event (auth, owner only)
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { deliverToFollowers } from "../lib/federation.js";
import { notifyEventUpdated, notifyEventCancelled } from "../lib/notifications.js";
import { buildFeedQuery } from "../lib/feed-query.js";
import {
  buildDateRangeFilter,
  DateQueryParamError,
} from "../lib/date-query.js";
import { stripHtml, sanitizeHtml } from "../lib/security.js";
import { isValidVisibility, type EventVisibility } from "@everycal/core";
import { getLocale, t } from "../lib/i18n.js";
import { generateAndSaveOgImage } from "./og-images.js";
import { canManageIdentityEvents, listActingAccounts } from "../lib/identities.js";
import { fetchAP, resolveRemoteActor, validateFederationUrl } from "../lib/federation.js";
import { uniqueLocalEventSlug, uniqueRemoteEventSlug } from "../lib/slugs.js";
import { upsertRemoteEvent } from "../lib/remote-events.js";
import {
  deriveEventEndAtUtc,
  deriveEventUtcRange,
  deriveUtcFromTemporalInput,
  isValidIanaTimezone,
  normalizeApTemporal,
} from "../lib/timezone.js";
import {
  ActorSelectionPayloadError,
  applyLocalActorSelection,
  buildActorSelectionPlan,
  isDesiredAccountIdsAllowed,
  readActorSelectionPayload,
  summarizeActorSelection,
} from "../lib/actor-selection.js";
import { serializeLocalEvent, serializeRemoteEvent } from "../lib/event-serializers.js";
import { AP_CONTEXT, EVERYCAL_CONTEXT, buildApEventObject } from "../lib/activitypub-event.js";

// ─── Reusable SQL fragments ─────────────────────────────────────────────────

const LOCAL_EVENT_SELECT = `
  SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
         GROUP_CONCAT(DISTINCT t.tag) AS tags
  FROM events e
  JOIN accounts a ON a.id = e.account_id
  LEFT JOIN event_tags t ON t.event_id = e.id`;

const REMOTE_EVENT_SELECT = `
  SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
         ra.domain, ra.icon_url AS actor_icon_url, ra.fetch_status AS actor_fetch_status
  FROM remote_events re
  LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri`;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// ─── Pure utility functions ─────────────────────────────────────────────────


function sanitizeEventFields(body: Record<string, unknown>): void {
  if (typeof body.title === "string") body.title = stripHtml(body.title);
  if (typeof body.description === "string") body.description = sanitizeHtml(body.description);
  if (body.location && typeof body.location === "object") {
    const loc = body.location as Record<string, unknown>;
    if (typeof loc.name === "string") loc.name = stripHtml(loc.name);
    if (typeof loc.address === "string") loc.address = stripHtml(loc.address);
  }
  if (body.tags && Array.isArray(body.tags)) {
    body.tags = (body.tags as string[]).map((t) => stripHtml(t));
  }
}

/** Decode an event ID that may be URL-encoded into a URI. */
function resolveEventUri(id: string): string {
  if (id.startsWith("http")) return id;
  try {
    const decoded = decodeURIComponent(id);
    if (decoded.startsWith("http")) return decoded;
  } catch { /* not URL-encoded */ }
  return id;
}

function formatTimeChangeValue(start: string, end: string | null | undefined): string {
  return [start, end || ""].filter(Boolean).join(" – ");
}

function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/** Check whether a user is allowed to view an event based on its visibility. */
function canViewEvent(
  db: DB,
  visibility: string,
  ownerId: string,
  currentUser?: { id: string } | null,
): boolean {
  if (visibility === "public" || visibility === "unlisted") return true;
  if (!currentUser) return false;
  if (currentUser.id === ownerId) return true;
  const membership = db
    .prepare(
      `SELECT 1 FROM identity_memberships im
       JOIN accounts a ON a.id = im.identity_account_id
       WHERE im.identity_account_id = ?
         AND a.account_type = 'identity'
         AND im.member_account_id = ?
         AND im.role IN ('editor','owner')`
    )
    .get(ownerId, currentUser.id);
  if (membership) return true;
  if (visibility === "followers_only") {
    return !!db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
      .get(currentUser.id, ownerId);
  }
  return false;
}

type DateRangeColumns = { instantColumn: string; dateColumn: string };

/**
 * Build SQL + params for optional date-range filters across paired columns.
 * `instantColumn` is used for timestamp bounds; `dateColumn` is used for
 * date-only bounds.
 */
function appendDateRangeFilters(
  columns: DateRangeColumns,
  from?: string,
  to?: string,
): { sql: string; params: unknown[] } {
  return buildDateRangeFilter(columns, from, to);
}

/**
 * Build a LIKE-based tag filter for remote events.
 * Remote tags are stored as a comma-separated string, so exact match + boundary
 * variants are needed to avoid partial matches.
 */
function buildRemoteTagFilter(tagList: string[]): { sql: string; params: unknown[] } {
  if (tagList.length === 0) return { sql: "", params: [] };
  const escapeLike = (s: string) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  const conditions = tagList
    .map(() => `(re.tags = ? OR re.tags LIKE ? OR re.tags LIKE ? OR re.tags LIKE ?)`)
    .join(" OR ");
  const params: unknown[] = [];
  for (const tag of tagList) {
    const escaped = escapeLike(tag);
    params.push(tag, `${escaped},%`, `%,${escaped},%`, `%,${escaped}`);
  }
  return { sql: ` AND (${conditions})`, params };
}

/** Merge local + remote events by canonical UTC start instant, capped at `limit`. */
function mergeByStartAtUtc(
  local: Record<string, unknown>[],
  remote: Record<string, unknown>[],
  limit: number,
): Record<string, unknown>[] {
  return [...local, ...remote]
    .sort((a, b) => ((a.startAtUtc as string) || "").localeCompare((b.startAtUtc as string) || ""))
    .slice(0, limit);
}

// ─── Response formatters ────────────────────────────────────────────────────

function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return serializeLocalEvent(row);
}

function formatRemoteEvent(row: Record<string, unknown>): Record<string, unknown> {
  return serializeRemoteEvent(row);
}

// ─── Route definitions ──────────────────────────────────────────────────────

export function eventRoutes(db: DB): Hono {
  const router = new Hono();

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
    const stmt = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");
    for (const tag of tags) stmt.run(eventId, tag.trim());
  }

  /** Delete then re-insert tags for an event. */
  function replaceTags(eventId: string, tags: string[]): void {
    db.prepare("DELETE FROM event_tags WHERE event_id = ?").run(eventId);
    saveTags(eventId, tags);
  }

  // ─── GET /tags ──────────────────────────────────────────────────────────

  router.get("/tags", (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const scope = c.req.query("scope");
    const user = c.get("user");
    const isMineScope = scope === "mine" && !!user;
    const isCalendarScope = scope === "calendar" && !!user;

    const allTags = new Set<string>();

    try {

    // Local event tags
    {
      let sql: string;
      const params: unknown[] = [];

      if (isCalendarScope) {
        sql = `SELECT DISTINCT t.tag FROM event_tags t
          JOIN events e ON e.id = t.event_id
          WHERE e.id IN (SELECT event_uri FROM event_rsvps WHERE account_id = ? AND status IN ('going','maybe'))
          AND (
            e.visibility IN ('public','unlisted')
            OR e.account_id = ?
            OR (e.visibility = 'followers_only' AND EXISTS (
              SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id
            ))
          )`;
        params.push(user!.id, user!.id, user!.id);
      } else if (isMineScope) {
        const baseUrl = process.env.BASE_URL || "http://localhost:3000";
        const feed = buildFeedQuery({ userId: user!.id, baseUrl });
        sql = `SELECT DISTINCT t.tag FROM event_tags t
          WHERE t.event_id IN (SELECT combined.id FROM (${feed.sql}) AS combined WHERE 1=1`;
        params.push(...feed.params);
      } else {
        sql = `SELECT DISTINCT t.tag FROM event_tags t
          JOIN events e ON e.id = t.event_id
          JOIN accounts a ON a.id = e.account_id
          WHERE e.visibility = 'public'`;
      }

      const df = appendDateRangeFilters(
        {
          instantColumn: isMineScope ? "combined.start_at_utc" : "e.start_at_utc",
          dateColumn: isMineScope ? "combined.start_on" : "e.start_on",
        },
        from,
        to,
      );
      sql += df.sql;
      params.push(...df.params);

      if (isMineScope) sql += ")";

      const rows = db.prepare(sql).all(...params) as { tag: string }[];
      for (const r of rows) allTags.add(r.tag);
    }

    // Remote event tags
    {
      let sql = `SELECT re.tags FROM remote_events re WHERE re.tags IS NOT NULL AND re.tags != ''`;
      const params: unknown[] = [];

      if (isCalendarScope) {
        sql += ` AND re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ? AND status IN ('going','maybe'))`;
        params.push(user!.id);
      } else if (isMineScope) {
        sql += ` AND (re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?) OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?))`;
        params.push(user!.id, user!.id);
      }

      const df = appendDateRangeFilters({ instantColumn: "re.start_at_utc", dateColumn: "re.start_on" }, from, to);
      sql += df.sql;
      params.push(...df.params);

      const rows = db.prepare(sql).all(...params) as { tags: string }[];
      for (const r of rows) {
        for (const tag of r.tags.split(",")) {
          const t = tag.trim();
          if (t) allTags.add(t);
        }
      }
    }

      return c.json({ tags: [...allTags].sort() });
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // ─── GET / — list events ───────────────────────────────────────────────

  router.get("/", (c) => {
    const account = c.req.query("account");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const q = c.req.query("q");
    const source = c.req.query("source");
    const scope = c.req.query("scope");
    const tagsParam = c.req.query("tags");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const tagList = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const user = c.get("user");
    const isMineScope = scope === "mine" && !!user;
    const isCalendarScope = scope === "calendar" && !!user;

    let localEvents: Record<string, unknown>[] = [];
    let remoteEvents: Record<string, unknown>[] = [];

    try {

    // Fetch local events (unless source=remote)
    if (source !== "remote") {
      let sql: string;
      const params: unknown[] = [];

      if (isCalendarScope) {
        sql = `${LOCAL_EVENT_SELECT}
          WHERE e.id IN (
            SELECT event_uri FROM event_rsvps
            WHERE account_id = ? AND status IN ('going','maybe')
          )
          AND (
            e.visibility IN ('public','unlisted')
            OR e.account_id = ?
            OR (e.visibility = 'followers_only' AND EXISTS (
              SELECT 1 FROM follows WHERE follower_id = ? AND following_id = e.account_id
            ))
          )`;
        params.push(user!.id, user!.id, user!.id);
      } else if (isMineScope) {
        const baseUrl = process.env.BASE_URL || "http://localhost:3000";
        const feed = buildFeedQuery({ userId: user!.id, baseUrl });
        sql = feed.sql;
        params.push(...feed.params);
      } else if (user) {
        sql = `${LOCAL_EVENT_SELECT} WHERE (e.visibility = 'public' OR e.account_id = ?)`;
        params.push(user.id);
      } else {
        sql = `${LOCAL_EVENT_SELECT} WHERE e.visibility = 'public'`;
      }

      // Columns use "combined" prefix for mine-scope (buildFeedQuery subquery alias), "e" otherwise
      const col = isMineScope ? "combined" : "e";

      if (account) {
        sql += isMineScope ? ` AND combined.account_username = ?` : ` AND a.username = ?`;
        params.push(account);
      }

      const df = appendDateRangeFilters(
        { instantColumn: `${col}.start_at_utc`, dateColumn: `${col}.start_on` },
        from,
        to,
      );
      sql += df.sql;
      params.push(...df.params);

      if (q) {
        sql += ` AND (${col}.title LIKE ? OR ${col}.description LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`);
      }
      if (tagList.length > 0) {
        const placeholders = tagList.map(() => "?").join(",");
        sql += ` AND ${col}.id IN (SELECT event_id FROM event_tags WHERE tag IN (${placeholders}))`;
        params.push(...tagList);
      }

      sql += ` GROUP BY ${col}.id ORDER BY ${col}.start_at_utc ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      localEvents = rows.map((r) => ({ ...formatEvent(r), source: "local" }));
    }

    // Fetch remote events (unless source=local)
    if (source !== "local") {
      let sql = `${REMOTE_EVENT_SELECT} WHERE 1=1`;
      const params: unknown[] = [];

      if (isCalendarScope) {
        sql += ` AND re.uri IN (
          SELECT event_uri FROM event_rsvps WHERE account_id = ? AND status IN ('going','maybe')
        )`;
        params.push(user!.id);
      } else if (isMineScope) {
        sql += ` AND (
          re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
          OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?)
        )`;
        params.push(user!.id, user!.id);
      }

      const df = appendDateRangeFilters({ instantColumn: "re.start_at_utc", dateColumn: "re.start_on" }, from, to);
      sql += df.sql;
      params.push(...df.params);

      if (q) {
        sql += ` AND (re.title LIKE ? OR re.description LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`);
      }

      const tagFilter = buildRemoteTagFilter(tagList);
      sql += tagFilter.sql;
      params.push(...tagFilter.params);

      sql += ` ORDER BY re.start_at_utc ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      remoteEvents = rows.map(formatRemoteEvent);
    }

      let events = mergeByStartAtUtc(localEvents, remoteEvents, limit);
      if (user) events = attachUserContext(events, user.id);

      return c.json({ events });
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // ─── POST /rsvp ────────────────────────────────────────────────────────

  router.post("/rsvp", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ eventUri: string; status: string | null }>();

    if (!body.eventUri) return c.json({ error: t(getLocale(c), "events.event_uri_required") }, 400);

    if (body.status === null || body.status === undefined || body.status === "") {
      db.prepare("DELETE FROM event_rsvps WHERE account_id = ? AND event_uri = ?").run(user.id, body.eventUri);
      return c.json({ ok: true, status: null });
    }

    if (!["going", "maybe"].includes(body.status)) {
      return c.json({ error: t(getLocale(c), "events.status_invalid") }, 400);
    }

    const localEvent = db.prepare("SELECT id FROM events WHERE id = ?").get(body.eventUri);
    const remoteEvent = !localEvent
      ? db.prepare("SELECT uri FROM remote_events WHERE uri = ?").get(body.eventUri)
      : null;
    if (!localEvent && !remoteEvent) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);

    db.prepare(
      `INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, ?)
       ON CONFLICT(account_id, event_uri) DO UPDATE SET status = excluded.status`
    ).run(user.id, body.eventUri, body.status);

    return c.json({ ok: true, status: body.status });
  });

  // ─── GET /timeline ─────────────────────────────────────────────────────

  router.get("/timeline", requireAuth(), (c) => {
    const user = c.get("user")!;
    const from = c.req.query("from") || new Date().toISOString();
    const to = c.req.query("to");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    try {

    // Local: feed events (own + followed + reposted)
    let localEvents: Record<string, unknown>[];
    {
      const baseUrl = process.env.BASE_URL || "http://localhost:3000";
      const feed = buildFeedQuery({ userId: user.id, baseUrl });
      let sql = feed.sql;
      const params = [...feed.params];

      const df = appendDateRangeFilters(
        { instantColumn: "combined.start_at_utc", dateColumn: "combined.start_on" },
        from,
        to,
      );
      sql += df.sql;
      params.push(...df.params);

      sql += ` GROUP BY combined.id ORDER BY combined.start_at_utc ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      localEvents = rows.map((r) => ({ ...formatEvent(r), source: "local" }));
    }

    // Remote: events from followed actors + RSVP'd events
    let remoteEvents: Record<string, unknown>[];
    {
      let sql = `${REMOTE_EVENT_SELECT}
        WHERE (
            re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
            OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?)
          )`;
      const params: unknown[] = [user.id, user.id];

      const df = appendDateRangeFilters({ instantColumn: "re.start_at_utc", dateColumn: "re.start_on" }, from, to);
      sql += df.sql;
      params.push(...df.params);

      sql += ` ORDER BY re.start_at_utc ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      remoteEvents = rows.map(formatRemoteEvent);
    }

    let events = mergeByStartAtUtc(localEvents, remoteEvents, limit);

    // Timeline only attaches RSVPs (no repost flags)
    const uris = events.map((e) => e.id as string);
    const rsvps = getUserRsvps(user.id, uris);
    events = events.map((e) => ({ ...e, rsvpStatus: rsvps.get(e.id as string) || null }));

      return c.json({ events });
    } catch (error) {
      if (error instanceof DateQueryParamError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // ─── POST /sync — full replace for scraper accounts ─────────────────────

  router.post("/sync", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{
      events: {
        externalId: string;
        title: string;
        description?: string;
        startDate: string;
        endDate?: string;
        eventTimezone: string;
        allDay?: boolean;
        location?: { name: string; address?: string; latitude?: number; longitude?: number; url?: string };
        image?: { url: string; mediaType?: string; alt?: string };
        url?: string;
        tags?: string[];
        visibility?: string;
      }[];
    }>();

    if (!Array.isArray(body.events)) {
      return c.json({ error: t(getLocale(c), "events.events_array_required") }, 400);
    }

    for (const ev of body.events) {
      if (!ev.externalId || !ev.title || !ev.startDate || !ev.eventTimezone || !isValidIanaTimezone(ev.eventTimezone)) {
        return c.json({ error: t(getLocale(c), "events.event_requires_fields") }, 400);
      }
      if (ev.allDay) {
        if (!isDateOnly(ev.startDate) || (ev.endDate !== undefined && !isDateOnly(ev.endDate))) {
          return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
        }
      }
      const { startAtUtc, endAtUtc } = deriveEventUtcRange(
        ev.startDate,
        ev.endDate,
        { allDay: !!ev.allDay, eventTimezone: ev.eventTimezone },
      );
      if (!startAtUtc || (ev.allDay ? !endAtUtc : (ev.endDate && !endAtUtc)) || (endAtUtc && endAtUtc < startAtUtc)) {
        return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
      }
    }

    const deduped = [...new Map(body.events.map((ev) => [ev.externalId, ev])).values()];

    for (const ev of deduped) {
      sanitizeEventFields(ev as Record<string, unknown>);
    }

    const existing = db
      .prepare(
        "SELECT id, slug, external_id, content_hash, title, start_date, end_date, start_at_utc, end_at_utc, event_timezone, all_day, location_name, location_address, url, description, canceled, missing_since FROM events WHERE account_id = ? AND external_id IS NOT NULL"
      )
      .all(user.id) as {
      id: string;
      slug: string | null;
      external_id: string;
      content_hash: string | null;
      title: string;
      start_date: string;
      end_date: string | null;
      start_at_utc: string;
      end_at_utc: string | null;
      all_day: number;
      location_name: string | null;
      location_address: string | null;
      event_timezone: string | null;
      url: string | null;
      description: string | null;
      canceled: number;
      missing_since: string | null;
    }[];

    const existingByExtId = new Map(existing.map((r) => [r.external_id, r]));
    const incomingExtIds = new Set(deduped.map((e) => e.externalId));

    let created = 0;
    let updated = 0;
    let canceled = 0;
    let rotatedOutPast = 0;
    let unchanged = 0;

    function eventHash(ev: (typeof body.events)[number]): string {
      const data = JSON.stringify([
        ev.title, ev.description || "", ev.startDate, ev.endDate || "", ev.eventTimezone,
        ev.allDay ? 1 : 0, ev.location?.name || "", ev.location?.address || "",
        ev.location?.latitude ?? "", ev.location?.longitude ?? "",
        ev.location?.url || "", ev.image?.url || "", ev.image?.mediaType || "",
        ev.image?.alt || "", ev.url || "", ev.visibility || "public",
        (ev.tags || []).slice().sort().join(","),
      ]);
      return createHash("sha256").update(data).digest("base64url").slice(0, 22);
    }

    const insertEvent = db.prepare(
      `INSERT INTO events (id, account_id, created_by_account_id, external_id, slug, title, description, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, start_on, end_on,
        location_name, location_address, location_latitude, location_longitude, location_url,
        image_url, image_media_type, image_alt, url, visibility, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const updateEvent = db.prepare(
      `UPDATE events SET title = ?, slug = ?, description = ?, start_date = ?, end_date = ?, all_day = ?, start_at_utc = ?, end_at_utc = ?, event_timezone = ?, start_on = ?, end_on = ?,
        location_name = ?, location_address = ?, location_latitude = ?, location_longitude = ?, location_url = ?,
        image_url = ?, image_media_type = ?, image_alt = ?, url = ?, visibility = ?,
        content_hash = ?, canceled = 0, missing_since = NULL, updated_at = datetime('now')
       WHERE id = ?`
    );

    const restoreEventState = db.prepare(
      "UPDATE events SET canceled = 0, missing_since = NULL, updated_at = datetime('now') WHERE id = ?"
    );

    const deleteTagsStmt = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
    const insertTagStmt = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");

    const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

    // Batch 1: Handle events no longer present in the scraped set.
    // Policy:
    // - Past events are kept as-is (rotated out of source listing).
    // - Future events are marked canceled (never deleted), but only after
    //   they are missing in two consecutive syncs to avoid accidental cancels
    //   from transient scrape issues.
    const nowIso = new Date().toISOString();
    const missingRows = existing.filter((r) => !incomingExtIds.has(r.external_id));
    if (missingRows.length > 0) {
      const markMissingSeen = db.prepare("UPDATE events SET missing_since = COALESCE(missing_since, datetime('now')) WHERE id = ?");
      const markCanceled = db.prepare("UPDATE events SET canceled = 1, missing_since = datetime('now'), updated_at = datetime('now') WHERE id = ?");
      const clearMissingForPast = db.prepare("UPDATE events SET missing_since = NULL WHERE id = ?");

      const missingBatch = db.transaction((rows: typeof missingRows) => {
        for (const row of rows) {
          if (row.start_at_utc < nowIso) {
            clearMissingForPast.run(row.id);
            rotatedOutPast++;
            continue;
          }

          if (!row.missing_since) {
            markMissingSeen.run(row.id);
            continue;
          }

          if (!row.canceled) {
            markCanceled.run(row.id);
            canceled++;
          } else {
            markMissingSeen.run(row.id);
          }
        }
      });

      missingBatch(missingRows);

      for (const row of missingRows) {
        if (row.start_at_utc >= nowIso && row.missing_since && !row.canceled) {
          notifyEventCancelled(db, row.id, {
            id: row.id,
            title: row.title,
            slug: row.slug || row.id,
            account: { username: user.username },
            startDate: row.start_date,
            endDate: row.end_date,
            allDay: !!row.all_day,
            location: row.location_name ? { name: row.location_name } : null,
            url: row.url,
          });
        }
      }
      await yieldToEventLoop();
    }

    // Batch 2+: Upsert incoming events in chunks — skip unchanged events
    const BATCH_SIZE = 20;
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const chunk = deduped.slice(i, i + BATCH_SIZE);

      const upsertBatch = db.transaction((events: typeof chunk) => {
        for (const ev of events) {
          const visibility = ev.visibility || "public";
          if (!isValidVisibility(visibility)) continue;
          const hash = eventHash(ev);
          const existingRow = existingByExtId.get(ev.externalId);

          if (existingRow) {
            if (existingRow.content_hash === hash) {
              if (existingRow.canceled || existingRow.missing_since) {
                restoreEventState.run(existingRow.id);
              }
              unchanged++;
              continue;
            }

            // Only material changes (title, time, location) trigger notifications
            const changes: { field: "title" | "time" | "location"; before?: string; after?: string; beforeAllDay?: boolean; afterAllDay?: boolean }[] = [];
            if (existingRow.title !== ev.title) {
              changes.push({ field: "title", before: existingRow.title, after: ev.title });
            }
            const oldAllDay = !!existingRow.all_day;
            const newAllDay = !!ev.allDay;
            const oldTime = formatTimeChangeValue(existingRow.start_date, existingRow.end_date);
            const newTime = formatTimeChangeValue(ev.startDate, ev.endDate || "");
            const { startAtUtc: nextStartAtUtc, endAtUtc: nextEndAtUtc } = deriveEventUtcRange(
              ev.startDate,
              ev.endDate,
              { allDay: !!ev.allDay, eventTimezone: ev.eventTimezone },
            );
            const existingEffectiveStart = existingRow.start_date;
            const existingEffectiveEnd = existingRow.end_date;
            const nextEffectiveStart = ev.startDate;
            const nextEffectiveEnd = ev.endDate;
            const oldTimezone = existingRow.event_timezone || "";
            const newTimezone = ev.eventTimezone || "";
            const oldStartAtUtc = existingRow.start_at_utc || "";
            const oldEndAtUtc = existingRow.end_at_utc || "";
            const newStartAtUtc = nextStartAtUtc || "";
            const newEndAtUtc = nextEndAtUtc || "";
            if (
              existingEffectiveStart !== nextEffectiveStart
              || (existingEffectiveEnd || "") !== (nextEffectiveEnd || "")
              || oldAllDay !== newAllDay
              || oldTimezone !== newTimezone
              || oldStartAtUtc !== newStartAtUtc
              || oldEndAtUtc !== newEndAtUtc
            ) {
              changes.push({ field: "time", before: oldTime, after: newTime, beforeAllDay: oldAllDay, afterAllDay: newAllDay });
            }
            const oldLoc = [existingRow.location_name || "", existingRow.location_address || ""].filter(Boolean).join(", ");
            const newLoc = [ev.location?.name || "", ev.location?.address || ""].filter(Boolean).join(", ");
            if (oldLoc !== newLoc) {
              changes.push({ field: "location", before: oldLoc, after: newLoc });
            }

            const evSlug = uniqueLocalEventSlug(db, user.id, ev.title, existingRow.id);
            updateEvent.run(
              ev.title, evSlug, ev.description || null,
              ev.startDate, ev.endDate || null, ev.allDay ? 1 : 0,
              nextStartAtUtc, nextEndAtUtc, ev.eventTimezone, ev.startDate.slice(0, 10), ev.endDate ? ev.endDate.slice(0, 10) : null,
              ev.location?.name || null, ev.location?.address || null,
              ev.location?.latitude ?? null, ev.location?.longitude ?? null,
              ev.location?.url || null,
              ev.image?.url || null, ev.image?.mediaType || null, ev.image?.alt || null,
              ev.url || null, visibility, hash, existingRow.id,
            );

            deleteTagsStmt.run(existingRow.id);
            if (ev.tags) {
              for (const tag of ev.tags) insertTagStmt.run(existingRow.id, tag.trim());
            }
            if (changes.length > 0) {
              notifyEventUpdated(db, existingRow.id, {
                id: existingRow.id,
                title: ev.title,
                slug: evSlug,
                account: { username: user.username },
                startDate: ev.startDate,
                endDate: ev.endDate || null,
                allDay: ev.allDay ?? false,
                location: ev.location ? { name: ev.location.name } : null,
                url: ev.url || null,
              }, changes);
            }
            updated++;
          } else {
            const id = nanoid(16);
            const evSlug = uniqueLocalEventSlug(db, user.id, ev.title);
            const { startAtUtc: nextStartAtUtc, endAtUtc: nextEndAtUtc } = deriveEventUtcRange(
              ev.startDate,
              ev.endDate,
              { allDay: !!ev.allDay, eventTimezone: ev.eventTimezone },
            );
            insertEvent.run(
              id, user.id, user.id, ev.externalId, evSlug,
              ev.title, ev.description || null,
              ev.startDate, ev.endDate || null, ev.allDay ? 1 : 0,
              nextStartAtUtc, nextEndAtUtc, ev.eventTimezone, ev.startDate.slice(0, 10), ev.endDate ? ev.endDate.slice(0, 10) : null,
              ev.location?.name || null, ev.location?.address || null,
              ev.location?.latitude ?? null, ev.location?.longitude ?? null,
              ev.location?.url || null,
              ev.image?.url || null, ev.image?.mediaType || null, ev.image?.alt || null,
              ev.url || null, visibility, hash,
            );

            if (ev.tags) {
              for (const tag of ev.tags) insertTagStmt.run(id, tag.trim());
            }
            created++;
          }
        }
      });

      upsertBatch(chunk);

      if (i + BATCH_SIZE < deduped.length) {
        await yieldToEventLoop();
      }
    }

    return c.json({ ok: true, created, updated, unchanged, canceled, rotatedOutPast, total: deduped.length });
  });

  // ─── POST /:id/repost ──────────────────────────────────────────────────

  router.post("/:id/repost", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const event = db.prepare("SELECT id, account_id, visibility FROM events WHERE id = ?").get(id) as
      | { id: string; account_id: string; visibility: string }
      | undefined;
    if (!event) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);
    if (event.visibility !== "public" && event.visibility !== "unlisted") {
      return c.json({ error: t(getLocale(c), "events.repost_public_unlisted_only") }, 403);
    }

    let body: { desiredAccountIds?: string[] };
    try {
      body = await readActorSelectionPayload(c);
    } catch (err) {
      if (err instanceof ActorSelectionPayloadError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
    if (!body.desiredAccountIds) {
      if (event.account_id === user.id) return c.json({ error: t(getLocale(c), "events.cannot_repost_own") }, 400);
      db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id) VALUES (?, ?)").run(user.id, id);
      return c.json({ ok: true, reposted: true });
    }

    const acting = listActingAccounts(db, user.id, "editor");
    const actingIds = acting.map((a) => a.id);
    if (!isDesiredAccountIdsAllowed(body.desiredAccountIds, actingIds)) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const activeRows = db
      .prepare("SELECT account_id FROM reposts WHERE event_id = ?")
      .all(id) as Array<{ account_id: string }>;
    const plan = buildActorSelectionPlan({
      actingAccountIds: actingIds,
      desiredAccountIds: body.desiredAccountIds,
      activeAccountIds: activeRows.map((r) => r.account_id),
      validateTransition: ({ accountId, after }) => {
        if (accountId === event.account_id && after) return t(getLocale(c), "events.cannot_repost_own");
        return null;
      },
    });

    const { operationId, results } = applyLocalActorSelection({
      db,
      operation: {
        actionKind: "event_repost",
        targetType: "event",
        targetId: id,
        initiatedByAccountId: user.id,
      },
      plan,
      applyAdd: (accountId) => {
        db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id) VALUES (?, ?)").run(accountId, id);
      },
      applyRemove: (accountId) => {
        db.prepare("DELETE FROM reposts WHERE account_id = ? AND event_id = ?").run(accountId, id);
      },
    });
    const summary = summarizeActorSelection(results);

    return c.json({
      ok: true,
      operationId,
      added: summary.added,
      removed: summary.removed,
      unchanged: summary.unchanged,
      failed: summary.failed,
      results,
    });
  });

  // ─── DELETE /:id/repost ─────────────────────────────────────────────────

  router.delete("/:id/repost", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    db.prepare("DELETE FROM reposts WHERE account_id = ? AND event_id = ?").run(user.id, id);
    return c.json({ ok: true, reposted: false });
  });

  router.get("/:id/repost-actors", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    const event = db.prepare("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | undefined;
    if (!event) return c.json({ error: t(getLocale(c), "events.event_not_found") }, 404);

    const acting = listActingAccounts(db, user.id, "editor");
    const allowed = new Set(acting.map((a) => a.id));
    const activeRows = db
      .prepare("SELECT account_id FROM reposts WHERE event_id = ?")
      .all(id) as Array<{ account_id: string }>;
    const activeAccountIds = activeRows.map((r) => r.account_id).filter((accountId) => allowed.has(accountId));
    return c.json({ activeAccountIds, actorIds: Array.from(allowed) });
  });

  // ─── GET /by-slug/:username/:slug ───────────────────────────────────────

  router.get("/by-slug/:username/:slug", (c) => {
    const username = c.req.param("username");
    const slug = c.req.param("slug");
    const currentUser = c.get("user");

    if (username.includes("@")) {
      const [preferredUsername, domain] = username.split("@");
      if (!preferredUsername || !domain) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
      const remoteRow = db
        .prepare(`${REMOTE_EVENT_SELECT} WHERE ra.preferred_username = ? AND ra.domain = ? AND re.slug = ?`)
        .get(preferredUsername, domain, slug) as Record<string, unknown> | undefined;
      if (!remoteRow) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
      const event = formatRemoteEvent(remoteRow);
      if (currentUser) attachSingleEventContext(event, remoteRow.uri as string, currentUser.id);
      return c.json(event);
    }

    const event = fetchLocalEvent("a.username = ? AND e.slug = ?", [username, slug], currentUser);
    if (!event) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    return c.json(event);
  });

  router.get("/resolve", async (c) => {
    const locale = getLocale(c);
    const uri = c.req.query("uri")?.trim();
    if (!uri) return c.json({ error: t(locale, "events.resolve_uri_required") }, 400);

    const wantsHtml = (c.req.header("accept") || "").includes("text/html");

    let normalizedUri: string;
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
      normalizedUri = parsed.toString();
    } catch {
      return c.json({ error: t(locale, "events.resolve_invalid_uri") }, 400);
    }

    const existing = db
      .prepare(
        `SELECT re.*, ra.preferred_username, ra.domain
         FROM remote_events re
         JOIN remote_actors ra ON ra.uri = re.actor_uri
         WHERE re.uri = ?`
      )
      .get(normalizedUri) as Record<string, unknown> | undefined;
    if (existing?.preferred_username && existing.domain) {
      const resolvedSlug = (existing.slug as string | null) || uniqueRemoteEventSlug(
        db,
        existing.actor_uri as string,
        (existing.title as string) || "event",
      );
      if (!existing.slug) {
        db.prepare("UPDATE remote_events SET slug = ? WHERE uri = ?").run(resolvedSlug, existing.uri as string);
      }
      const path = `/@${existing.preferred_username}@${existing.domain}/${resolvedSlug}`;
      if (wantsHtml) return c.redirect(path, 302);
      return c.json({ path, event: formatRemoteEvent({ ...existing, slug: resolvedSlug }) });
    }

    try {
      await validateFederationUrl(normalizedUri);
    } catch {
      return c.json({ error: t(locale, "federation.private_address_not_allowed") }, 400);
    }

    try {
      const object = await fetchAP(normalizedUri) as Record<string, unknown>;
      const objectType = object.type;
      if (objectType !== "Event") return c.json({ error: t(locale, "events.resolve_not_event") }, 400);
      const title = object.name ?? object.title;
      const startDate = object.startTime ?? object.startDate;
      if (!title || !startDate || !object.id) {
        return c.json({ error: t(locale, "events.resolve_missing_required_fields") }, 400);
      }

      const attributedTo = object.attributedTo;
      const actorUri = typeof attributedTo === "string"
        ? attributedTo
        : Array.isArray(attributedTo)
          ? attributedTo.find((v): v is string => typeof v === "string")
          : undefined;
      if (!actorUri) return c.json({ error: t(locale, "events.resolve_missing_actor") }, 400);

      const actor = await resolveRemoteActor(db, actorUri, true);
      if (!actor) return c.json({ error: t(locale, "federation.could_not_resolve_actor") }, 404);

      const temporal = normalizeApTemporal(object);
      if (!temporal) return c.json({ error: t(locale, "events.invalid_datetime") }, 400);
      const stored = upsertRemoteEvent(db, object, actor.uri, { temporal });
      const path = `/@${actor.preferred_username}@${actor.domain}/${stored.slug}`;
      const row = db
        .prepare(`${REMOTE_EVENT_SELECT} WHERE re.uri = ?`)
        .get(stored.uri) as Record<string, unknown> | undefined;

      if (wantsHtml) return c.redirect(path, 302);
      return c.json({ path, event: row ? formatRemoteEvent(row) : null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: t(locale, "events.resolve_fetch_failed", { error: msg }) }, 502);
    }
  });

  // ─── GET /:id ───────────────────────────────────────────────────────────

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    const currentUser = c.get("user");
    const eventUri = resolveEventUri(id);

    // Try local first
    const localEvent = fetchLocalEvent("e.id = ?", [id], currentUser);
    if (localEvent) return c.json(localEvent);

    // Fall back to remote events if URI looks like a URL
    if (eventUri.startsWith("http://") || eventUri.startsWith("https://")) {
      const remoteRow = db
        .prepare(`${REMOTE_EVENT_SELECT} WHERE re.uri = ?`)
        .get(eventUri) as Record<string, unknown> | undefined;

      if (remoteRow) {
        const event = formatRemoteEvent(remoteRow);
        if (currentUser) {
          const rsvpRow = db
            .prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
            .get(currentUser.id, eventUri) as { status: string } | undefined;
          (event as Record<string, unknown>).rsvpStatus = rsvpRow?.status || null;
        }
        return c.json(event);
      }
    }

    return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
  });

  // ─── POST / — create event ─────────────────────────────────────────────

  router.post("/", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{
      title: string;
      description?: string;
      startDate: string;
      endDate?: string;
      startDateTime?: string;
      endDateTime?: string;
      eventTimezone?: string;
      allDay?: boolean;
      location?: {
        name: string;
        address?: string;
        latitude?: number;
        longitude?: number;
        url?: string;
      };
      image?: { url: string; mediaType?: string; alt?: string; attribution?: Record<string, unknown> };
      url?: string;
      tags?: string[];
      visibility?: string;
      postAsAccountId?: string;
    }>();

    const startDateInput = body.startDateTime || body.startDate;
    const endDateInput = body.endDateTime || body.endDate;
    const eventTimezone = body.eventTimezone;
    if (!body.title || !startDateInput) {
      return c.json({ error: t(getLocale(c), "events.title_startdate_required") }, 400);
    }
    if (!eventTimezone || !isValidIanaTimezone(eventTimezone)) {
      return c.json({ error: t(getLocale(c), "events.invalid_timezone") }, 400);
    }
    if (body.allDay) {
      if (body.startDateTime !== undefined || body.endDateTime !== undefined) {
        return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
      }
      if (!body.startDate || !isDateOnly(body.startDate)) {
        return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
      }
      if (body.endDate !== undefined && !isDateOnly(body.endDate)) {
        return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
      }
    }

    sanitizeEventFields(body as Record<string, unknown>);

    const postAsAccountId = body.postAsAccountId || user.id;
    const postingAccount = db
      .prepare("SELECT id, username, account_type, is_bot, discoverable, default_event_visibility FROM accounts WHERE id = ?")
      .get(postAsAccountId) as
      | {
          id: string;
          username: string;
          account_type: string;
          is_bot: number;
          discoverable: number;
          default_event_visibility: EventVisibility;
        }
      | undefined;
    if (!postingAccount) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);

    if (postAsAccountId !== user.id) {
      if (postingAccount.account_type !== "identity") {
        return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
      }
      if (!canManageIdentityEvents(db, postingAccount.id, user.id, "editor")) {
        return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
      }
    }

    const id = nanoid(16);
    const slug = uniqueLocalEventSlug(db, postingAccount.id, body.title);

    const fallbackVisibility: EventVisibility = postingAccount.is_bot || postingAccount.discoverable ? "public" : "private";
    const defaultVisibility = isValidVisibility(postingAccount.default_event_visibility)
      ? postingAccount.default_event_visibility
      : fallbackVisibility;
    const visibility = body.visibility || defaultVisibility;

    if (!isValidVisibility(visibility)) {
      return c.json({ error: t(getLocale(c), "events.invalid_visibility") }, 400);
    }

    const imageAttributionJson = body.image?.attribution
      ? JSON.stringify(body.image.attribution)
      : null;
    const { startAtUtc, endAtUtc } = deriveEventUtcRange(
      startDateInput,
      endDateInput,
      { allDay: !!body.allDay, eventTimezone },
    );
    if (!startAtUtc) {
      return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
    }
    if ((body.allDay || endDateInput) && !endAtUtc) {
      return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
    }
    if (endAtUtc && endAtUtc < startAtUtc) {
      return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
    }

    db.prepare(
      `INSERT INTO events (id, account_id, created_by_account_id, slug, title, description, start_date, end_date, all_day,
        start_at_utc, end_at_utc, event_timezone, start_on, end_on,
        location_name, location_address, location_latitude, location_longitude, location_url,
        image_url, image_media_type, image_alt, image_attribution, url, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, postingAccount.id, user.id, slug, body.title, body.description || null,
      startDateInput, endDateInput || null, body.allDay ? 1 : 0,
      startAtUtc,
      endAtUtc,
      eventTimezone,
      startDateInput.slice(0, 10),
      endDateInput ? endDateInput.slice(0, 10) : null,
      body.location?.name || null, body.location?.address || null,
      body.location?.latitude ?? null, body.location?.longitude ?? null,
      body.location?.url || null,
      body.image?.url || null, body.image?.mediaType || null,
      body.image?.alt || null, imageAttributionJson,
      body.url || null, visibility,
    );

    if (body.tags && body.tags.length > 0) saveTags(id, body.tags);

    // Creator is going by default
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run(user.id, id);

    // Deliver Create activity to remote followers
    if (visibility === "public" || visibility === "unlisted") {
      const baseUrl = process.env.BASE_URL || "http://localhost:3000";
      const actorUrl = `${baseUrl}/users/${postingAccount.username}`;
      const publishedAt = new Date().toISOString();
      const createActivity = {
        "@context": [AP_CONTEXT, EVERYCAL_CONTEXT],
        id: `${baseUrl}/events/${id}/activity`,
        type: "Create",
        actor: actorUrl,
        published: publishedAt,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [`${actorUrl}/followers`],
        object: buildApEventObject({
          id: `${baseUrl}/events/${id}`,
          name: body.title,
          attributedTo: actorUrl,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: [`${actorUrl}/followers`],
          allDay: !!body.allDay,
          startDate: startDateInput,
          endDate: endDateInput || undefined,
          startAtUtc,
          endAtUtc,
          content: body.description || undefined,
          eventTimezone,
          url: `${baseUrl}/@${postingAccount.username}/${slug}`,
          published: publishedAt,
          updated: publishedAt,
        }),
      };
      deliverToFollowers(db, postingAccount.id, createActivity).catch(() => {});
    }

    const response = readLocalEventById(id);
    if (!response) return c.json({ error: t(getLocale(c), "events.event_not_found_after_create") }, 500);
    response.rsvpStatus = "going";

    generateAndSaveOgImage(db, id)
      .then()
      .catch((err) => console.error(`[OG] Failed to create OG image for event ${id}:`, err));

    return c.json(response, 201);
  });

  // ─── PUT /:id — update event ───────────────────────────────────────────

  router.put("/:id", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const existing = db
      .prepare("SELECT account_id, visibility, title, start_date, end_date, all_day, location_name, location_address, event_timezone FROM events WHERE id = ?")
      .get(id) as {
      account_id: string;
      visibility: string;
      title: string;
      start_date: string;
      end_date: string | null;
      all_day: number;
      location_name: string | null;
      location_address: string | null;
      event_timezone: string | null;
    } | undefined;
    if (!existing) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
    if (!canManageIdentityEvents(db, existing.account_id, user.id, "editor")) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const body = await c.req.json<{
      title?: string;
      description?: string;
      startDate?: string;
      startDateTime?: string;
      endDate?: string | null;
      endDateTime?: string | null;
      eventTimezone?: string;
      allDay?: boolean;
      location?: { name: string; address?: string; latitude?: number; longitude?: number; url?: string } | null;
      image?: { url: string; mediaType?: string; alt?: string; attribution?: Record<string, unknown> } | null;
      url?: string | null;
      tags?: string[];
      visibility?: string;
    }>();

    sanitizeEventFields(body as Record<string, unknown>);

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.title !== undefined) {
      fields.push("title = ?"); values.push(body.title);
    }
    if (body.description !== undefined) { fields.push("description = ?"); values.push(body.description || null); }
    const nextStart = body.startDateTime ?? body.startDate;
    const nextEnd = body.endDateTime ?? body.endDate;
    const nextTimezone = body.eventTimezone;
    if (nextTimezone !== undefined && !isValidIanaTimezone(nextTimezone)) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    const existingTimezone = isValidIanaTimezone(existing.event_timezone || "")
      ? (existing.event_timezone as string)
      : "UTC";
    const nextAllDay = body.allDay ?? !!existing.all_day;
    if (nextAllDay) {
      if (body.startDateTime !== undefined || body.endDateTime !== undefined) {
        return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
      }
      const candidateStart = body.startDate ?? existing.start_date;
      const candidateEnd = body.endDate !== undefined ? body.endDate : existing.end_date;
      if (!isDateOnly(candidateStart) || (candidateEnd !== null && candidateEnd !== undefined && !isDateOnly(candidateEnd))) {
        return c.json({ error: t(getLocale(c), "events.invalid_datetime") }, 400);
      }
    }
    const tzForConvert = nextTimezone ?? existingTimezone;
    const shouldRecomputeUtcForTimezoneChange = nextTimezone !== undefined;
    const startForUtc = nextStart ?? (shouldRecomputeUtcForTimezoneChange ? existing.start_date : undefined);
    const shouldRecomputeAllDayEndBoundary = nextAllDay && (nextStart !== undefined || body.allDay !== undefined);
    const endForUtc = nextEnd !== undefined
      ? nextEnd
      : ((shouldRecomputeUtcForTimezoneChange || shouldRecomputeAllDayEndBoundary) ? existing.end_date : undefined);
    const nextStartAtUtc = startForUtc !== undefined
      ? deriveUtcFromTemporalInput(startForUtc, { allDay: nextAllDay, eventTimezone: tzForConvert })
      : null;
    if (startForUtc !== undefined && !nextStartAtUtc) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    const baseStartForAllDayEnd = nextStart ?? existing.start_date;
    const nextEndAtUtc = endForUtc !== undefined
      ? deriveEventEndAtUtc(endForUtc, {
        allDay: nextAllDay,
        eventTimezone: tzForConvert,
        startValueForAllDay: baseStartForAllDayEnd,
      })
      : null;
    if (endForUtc !== undefined && (nextAllDay ? !nextEndAtUtc : (endForUtc !== null && !nextEndAtUtc))) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    if (nextStartAtUtc && nextEndAtUtc && nextEndAtUtc < nextStartAtUtc) {
      return c.json({ error: t(getLocale(c), "common.requestFailed") }, 400);
    }
    if (nextStart !== undefined) { fields.push("start_date = ?"); values.push(nextStart); }
    if (nextEnd !== undefined) { fields.push("end_date = ?"); values.push(nextEnd); }
    if (nextTimezone !== undefined) {
      fields.push("event_timezone = ?"); values.push(nextTimezone);
    } else if (existingTimezone !== existing.event_timezone) {
      fields.push("event_timezone = ?"); values.push(existingTimezone);
    }
    if (startForUtc !== undefined) {
      fields.push("start_at_utc = ?");
      values.push(nextStartAtUtc);
      const startForDateParts = nextStart ?? existing.start_date;
      fields.push("start_on = ?");
      values.push(startForDateParts.slice(0, 10));
    }
    if (endForUtc !== undefined) {
      fields.push("end_at_utc = ?");
      values.push(endForUtc === null ? null : nextEndAtUtc);
      const endForDateParts = nextEnd !== undefined ? nextEnd : existing.end_date;
      fields.push("end_on = ?");
      values.push(endForDateParts ? endForDateParts.slice(0, 10) : null);
    }
    if (body.allDay !== undefined) { fields.push("all_day = ?"); values.push(body.allDay ? 1 : 0); }
    if (body.visibility !== undefined) {
      if (!isValidVisibility(body.visibility)) {
        return c.json({ error: t(getLocale(c), "events.invalid_visibility") }, 400);
      }
      fields.push("visibility = ?"); values.push(body.visibility);
    }
    if (body.url !== undefined) { fields.push("url = ?"); values.push(body.url); }

    if (body.location !== undefined) {
      if (body.location === null) {
        fields.push("location_name = NULL, location_address = NULL, location_latitude = NULL, location_longitude = NULL, location_url = NULL");
      } else {
        fields.push("location_name = ?"); values.push(body.location.name);
        fields.push("location_address = ?"); values.push(body.location.address || null);
        fields.push("location_latitude = ?"); values.push(body.location.latitude ?? null);
        fields.push("location_longitude = ?"); values.push(body.location.longitude ?? null);
        fields.push("location_url = ?"); values.push(body.location.url || null);
      }
    }

    if (body.image !== undefined) {
      if (body.image === null) {
        fields.push("image_url = NULL, image_media_type = NULL, image_alt = NULL, image_attribution = NULL");
      } else {
        fields.push("image_url = ?"); values.push(body.image.url);
        fields.push("image_media_type = ?"); values.push(body.image.mediaType || null);
        fields.push("image_alt = ?"); values.push(body.image.alt || null);
        fields.push("image_attribution = ?");
        values.push(body.image.attribution ? JSON.stringify(body.image.attribution) : null);
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    if (body.tags !== undefined) replaceTags(id, body.tags);

    const oldAllDay = !!existing.all_day;
    const newAllDay = body.allDay !== undefined ? !!body.allDay : oldAllDay;
    const oldTime = formatTimeChangeValue(existing.start_date, existing.end_date);
    const newTime = formatTimeChangeValue(nextStart ?? existing.start_date, nextEnd !== undefined ? (nextEnd || "") : (existing.end_date || ""));
    const oldTimezone = existingTimezone;
    const newTimezone = body.eventTimezone !== undefined ? body.eventTimezone : oldTimezone;
    const timeChanged = oldTime !== newTime || oldAllDay !== newAllDay || oldTimezone !== newTimezone;
    const oldLoc = [existing.location_name || "", existing.location_address || ""].filter(Boolean).join(", ");
    const newLoc = body.location === undefined
      ? oldLoc
      : body.location === null
        ? ""
        : [body.location.name || "", body.location.address || ""].filter(Boolean).join(", ");
    const locationChanged = oldLoc !== newLoc;
    const titleChanged = body.title !== undefined && existing.title !== body.title;

    if (fields.length > 0) {
      // Only material changes (title, time, location) trigger notifications
      const changes: { field: "title" | "time" | "location"; before?: string; after?: string; beforeAllDay?: boolean; afterAllDay?: boolean }[] = [];
      if (titleChanged) {
        changes.push({ field: "title", before: existing.title, after: body.title });
      }
      if (timeChanged) {
        changes.push({ field: "time", before: oldTime, after: newTime, beforeAllDay: oldAllDay, afterAllDay: newAllDay });
      }
      if (locationChanged) {
        changes.push({ field: "location", before: oldLoc, after: newLoc });
      }
      if (changes.length > 0) {
        const ev = readLocalEventById(id);
        if (ev) {
          notifyEventUpdated(db, id, {
            id,
            title: ev.title as string,
            slug: (ev.slug as string | null) || id,
            account: { username: user.username },
            startDate: ev.startDate as string,
            endDate: ev.endDate as string | null,
            allDay: ev.allDay as boolean,
            location: ev.location as { name?: string } | null,
            url: ev.url as string | null,
          }, changes);
        }
      }
    }

    // Deliver Update activity to remote followers
    if (existing.visibility === "public" || existing.visibility === "unlisted") {
      const updated = readLocalEventById(id);
      if (updated) {
        const baseUrl = process.env.BASE_URL || "http://localhost:3000";
        const actorAccount = db
          .prepare("SELECT username FROM accounts WHERE id = ?")
          .get(existing.account_id) as { username: string } | undefined;
        if (actorAccount) {
          const actorUrl = `${baseUrl}/users/${actorAccount.username}`;
          const updatedAt = new Date().toISOString();
          const updateActivity = {
            "@context": [AP_CONTEXT, EVERYCAL_CONTEXT],
            id: `${baseUrl}/events/${id}/update`,
            type: "Update",
            actor: actorUrl,
            published: updatedAt,
            to: ["https://www.w3.org/ns/activitystreams#Public"],
            cc: [`${actorUrl}/followers`],
            object: buildApEventObject({
              id: `${baseUrl}/events/${id}`,
              name: updated.title as string,
              attributedTo: actorUrl,
              to: ["https://www.w3.org/ns/activitystreams#Public"],
              cc: [`${actorUrl}/followers`],
              allDay: !!updated.allDay,
              startDate: updated.startDate,
              endDate: updated.endDate,
              startAtUtc: updated.startAtUtc,
              endAtUtc: updated.endAtUtc,
              content: updated.description as string | undefined,
              eventTimezone: updated.eventTimezone as string | undefined,
              url: `${baseUrl}/@${actorAccount.username}/${updated.slug}`,
              updated: updatedAt,
            }),
          };
          deliverToFollowers(db, existing.account_id, updateActivity).catch(() => {});
        }
      }
    }

    const updated = readLocalEventById(id);
    if (!updated) return c.json({ error: t(getLocale(c), "events.event_not_found_after_update") }, 500);

    const ogRelevantFieldsChanged =
      titleChanged ||
      timeChanged ||
      locationChanged ||
      body.image !== undefined;

    if (ogRelevantFieldsChanged) {
      generateAndSaveOgImage(db, id)
        .then()
        .catch((err) => console.error(`[OG] Failed to create OG image for event ${id}:`, err));
    }

    return c.json(updated);
  });

  // ─── DELETE /:id ────────────────────────────────────────────────────────

  router.delete("/:id", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const existing = db
      .prepare("SELECT account_id FROM events WHERE id = ?")
      .get(id) as { account_id: string } | undefined;
    if (!existing) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
    if (!canManageIdentityEvents(db, existing.account_id, user.id, "editor")) {
      return c.json({ error: t(getLocale(c), "common.forbidden") }, 403);
    }

    const actorAccount = db
      .prepare("SELECT username FROM accounts WHERE id = ?")
      .get(existing.account_id) as { username: string } | undefined;

    const ev = readLocalEventById(id);
    if (ev && actorAccount) {
      notifyEventCancelled(db, id, {
        id,
        title: ev.title as string,
        slug: (ev.slug as string) || id,
        account: { username: actorAccount.username },
        startDate: ev.startDate as string,
        endDate: ev.endDate as string | null,
        allDay: ev.allDay as boolean,
        location: ev.location as { name?: string } | null,
        url: ev.url as string | null,
      });
    }

    db.prepare("DELETE FROM events WHERE id = ?").run(id);

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    if (!actorAccount) return c.json({ ok: true });
    const actorUrl = `${baseUrl}/users/${actorAccount.username}`;
    const deleteActivity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${baseUrl}/events/${id}/delete`,
      type: "Delete",
      actor: actorUrl,
      object: `${baseUrl}/events/${id}`,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorUrl}/followers`],
    };
    deliverToFollowers(db, existing.account_id, deleteActivity).catch(() => {});

    return c.json({ ok: true });
  });

  return router;
}
