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
import { buildFeedQuery } from "../lib/feed-query.js";
import { buildToCondition, buildToParams } from "../lib/date-query.js";
import { stripHtml, sanitizeHtml } from "../lib/security.js";
import { isValidVisibility, type EventVisibility } from "@everycal/core";

// ─── Reusable SQL fragments ─────────────────────────────────────────────────

const LOCAL_EVENT_SELECT = `
  SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
         GROUP_CONCAT(DISTINCT t.tag) AS tags
  FROM events e
  JOIN accounts a ON a.id = e.account_id
  LEFT JOIN event_tags t ON t.event_id = e.id`;

const REMOTE_EVENT_SELECT = `
  SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
         ra.domain, ra.icon_url AS actor_icon_url
  FROM remote_events re
  LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri`;

// ─── Pure utility functions ─────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")    // non-alphanum → hyphen
    .replace(/^-+|-+$/g, "")        // trim hyphens
    .slice(0, 80);
}

function uniqueSlug(db: DB, accountId: string, title: string, excludeEventId?: string): string {
  const base = slugify(title) || "event";
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = db.prepare(
      `SELECT id FROM events WHERE account_id = ? AND slug = ?${excludeEventId ? " AND id != ?" : ""}`
    ).get(accountId, slug, ...(excludeEventId ? [excludeEventId] : [])) as { id: string } | undefined;
    if (!existing) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

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

/** Decode an event ID that may be URL-encoded or base64url-encoded into a URI. */
function resolveEventUri(id: string): string {
  if (id.startsWith("http")) return id;
  try {
    const decoded = decodeURIComponent(id);
    if (decoded.startsWith("http")) return decoded;
  } catch { /* not URL-encoded */ }
  try {
    const decoded = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    if (decoded.startsWith("http")) return decoded;
  } catch { /* not base64url */ }
  return id;
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
  if (visibility === "followers_only") {
    return !!db
      .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
      .get(currentUser.id, ownerId);
  }
  return false;
}

/** Build SQL + params for optional date-range filters on a column. */
function appendDateFilters(
  column: string,
  from?: string,
  to?: string,
): { sql: string; params: unknown[] } {
  let sql = "";
  const params: unknown[] = [];
  if (from) { sql += ` AND ${column} >= ?`; params.push(from); }
  if (to) { sql += buildToCondition(column); params.push(...buildToParams(to)); }
  return { sql, params };
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

/** Merge local + remote events by start date, capped at `limit`. */
function mergeByStartDate(
  local: Record<string, unknown>[],
  remote: Record<string, unknown>[],
  limit: number,
): Record<string, unknown>[] {
  return [...local, ...remote]
    .sort((a, b) => ((a.startDate as string) || "").localeCompare((b.startDate as string) || ""))
    .slice(0, limit);
}

// ─── Response formatters ────────────────────────────────────────────────────

function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    source: "local",
    accountId: row.account_id,
    account: row.account_username
      ? { username: row.account_username, displayName: row.account_display_name }
      : undefined,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: !!row.all_day,
    location: row.location_name
      ? {
          name: row.location_name,
          address: row.location_address,
          latitude: row.location_latitude,
          longitude: row.location_longitude,
          url: row.location_url,
        }
      : null,
    image: row.image_url
      ? {
          url: row.image_url,
          mediaType: row.image_media_type,
          alt: row.image_alt,
          attribution: row.image_attribution
            ? (() => { try { return JSON.parse(row.image_attribution as string); } catch { return undefined; } })()
            : undefined,
        }
      : null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: row.visibility,
    repostedBy: row.repost_username
      ? { username: row.repost_username as string, displayName: row.repost_display_name as string | null }
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatRemoteEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.uri,
    source: "remote",
    actorUri: row.actor_uri,
    account: row.preferred_username
      ? {
          username: `${row.preferred_username}@${row.domain}`,
          displayName: row.actor_display_name,
          domain: row.domain,
          iconUrl: row.actor_icon_url,
        }
      : null,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: false,
    location: row.location_name
      ? {
          name: row.location_name,
          address: row.location_address,
          latitude: row.location_latitude,
          longitude: row.location_longitude,
        }
      : null,
    image: row.image_url
      ? {
          url: row.image_url,
          mediaType: row.image_media_type,
          alt: row.image_alt,
          attribution: row.image_attribution
            ? (() => { try { return JSON.parse(row.image_attribution as string); } catch { return undefined; } })()
            : undefined,
        }
      : null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: "public",
    createdAt: row.published,
    updatedAt: row.updated,
  };
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
  function readLocalEventById(eventId: string): Record<string, unknown> {
    const row = db
      .prepare(`${LOCAL_EVENT_SELECT} WHERE e.id = ? GROUP BY e.id`)
      .get(eventId) as Record<string, unknown>;
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

      const dateCol = isMineScope ? "combined.start_date" : "e.start_date";
      const df = appendDateFilters(dateCol, from, to);
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

      const df = appendDateFilters("re.start_date", from, to);
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

      const df = appendDateFilters(`${col}.start_date`, from, to);
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

      sql += ` GROUP BY ${col}.id ORDER BY ${col}.start_date ASC LIMIT ? OFFSET ?`;
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

      const df = appendDateFilters("re.start_date", from, to);
      sql += df.sql;
      params.push(...df.params);

      if (q) {
        sql += ` AND (re.title LIKE ? OR re.description LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`);
      }

      const tagFilter = buildRemoteTagFilter(tagList);
      sql += tagFilter.sql;
      params.push(...tagFilter.params);

      sql += ` ORDER BY re.start_date ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      remoteEvents = rows.map(formatRemoteEvent);
    }

    let events = mergeByStartDate(localEvents, remoteEvents, limit);
    if (user) events = attachUserContext(events, user.id);

    return c.json({ events });
  });

  // ─── POST /rsvp ────────────────────────────────────────────────────────

  router.post("/rsvp", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ eventUri: string; status: string | null }>();

    if (!body.eventUri) return c.json({ error: "eventUri is required" }, 400);

    if (body.status === null || body.status === undefined || body.status === "") {
      db.prepare("DELETE FROM event_rsvps WHERE account_id = ? AND event_uri = ?").run(user.id, body.eventUri);
      return c.json({ ok: true, status: null });
    }

    if (!["going", "maybe"].includes(body.status)) {
      return c.json({ error: "status must be going, maybe, or null" }, 400);
    }

    const localEvent = db.prepare("SELECT id FROM events WHERE id = ?").get(body.eventUri);
    const remoteEvent = !localEvent
      ? db.prepare("SELECT uri FROM remote_events WHERE uri = ?").get(body.eventUri)
      : null;
    if (!localEvent && !remoteEvent) return c.json({ error: "Event not found" }, 404);

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

    // Local: feed events (own + followed + reposted)
    let localEvents: Record<string, unknown>[];
    {
      const baseUrl = process.env.BASE_URL || "http://localhost:3000";
      const feed = buildFeedQuery({ userId: user.id, baseUrl, dateFrom: from });
      let sql = feed.sql;
      const params = [...feed.params];

      const df = appendDateFilters("combined.start_date", undefined, to);
      sql += df.sql;
      params.push(...df.params);

      sql += ` GROUP BY combined.id ORDER BY combined.start_date ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      localEvents = rows.map((r) => ({ ...formatEvent(r), source: "local" }));
    }

    // Remote: events from followed actors + RSVP'd events
    let remoteEvents: Record<string, unknown>[];
    {
      let sql = `${REMOTE_EVENT_SELECT}
        WHERE re.start_date >= ?
          AND (
            re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
            OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?)
          )`;
      const params: unknown[] = [from, user.id, user.id];

      const df = appendDateFilters("re.start_date", undefined, to);
      sql += df.sql;
      params.push(...df.params);

      sql += ` ORDER BY re.start_date ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      remoteEvents = rows.map(formatRemoteEvent);
    }

    let events = mergeByStartDate(localEvents, remoteEvents, limit);

    // Timeline only attaches RSVPs (no repost flags)
    const uris = events.map((e) => e.id as string);
    const rsvps = getUserRsvps(user.id, uris);
    events = events.map((e) => ({ ...e, rsvpStatus: rsvps.get(e.id as string) || null }));

    return c.json({ events });
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
        allDay?: boolean;
        location?: { name: string; address?: string; latitude?: number; longitude?: number; url?: string };
        image?: { url: string; mediaType?: string; alt?: string };
        url?: string;
        tags?: string[];
        visibility?: string;
      }[];
    }>();

    if (!Array.isArray(body.events)) {
      return c.json({ error: "events array is required" }, 400);
    }

    for (const ev of body.events) {
      if (!ev.externalId || !ev.title || !ev.startDate) {
        return c.json({ error: "Each event requires externalId, title, and startDate" }, 400);
      }
    }

    const deduped = [...new Map(body.events.map((ev) => [ev.externalId, ev])).values()];

    for (const ev of deduped) {
      sanitizeEventFields(ev as Record<string, unknown>);
    }

    const existing = db
      .prepare("SELECT id, external_id, content_hash FROM events WHERE account_id = ? AND external_id IS NOT NULL")
      .all(user.id) as { id: string; external_id: string; content_hash: string | null }[];

    const existingByExtId = new Map(existing.map((r) => [r.external_id, r]));
    const incomingExtIds = new Set(deduped.map((e) => e.externalId));

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;

    function eventHash(ev: (typeof body.events)[number]): string {
      const data = JSON.stringify([
        ev.title, ev.description || "", ev.startDate, ev.endDate || "",
        ev.allDay ? 1 : 0, ev.location?.name || "", ev.location?.address || "",
        ev.location?.latitude ?? "", ev.location?.longitude ?? "",
        ev.location?.url || "", ev.image?.url || "", ev.image?.mediaType || "",
        ev.image?.alt || "", ev.url || "", ev.visibility || "public",
        (ev.tags || []).slice().sort().join(","),
      ]);
      return createHash("sha256").update(data).digest("base64url").slice(0, 22);
    }

    const insertEvent = db.prepare(
      `INSERT INTO events (id, account_id, external_id, slug, title, description, start_date, end_date, all_day,
        location_name, location_address, location_latitude, location_longitude, location_url,
        image_url, image_media_type, image_alt, url, visibility, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const updateEvent = db.prepare(
      `UPDATE events SET title = ?, slug = ?, description = ?, start_date = ?, end_date = ?, all_day = ?,
        location_name = ?, location_address = ?, location_latitude = ?, location_longitude = ?, location_url = ?,
        image_url = ?, image_media_type = ?, image_alt = ?, url = ?, visibility = ?,
        content_hash = ?, updated_at = datetime('now')
       WHERE id = ?`
    );

    const deleteTagsStmt = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
    const insertTagStmt = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");

    const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

    // Batch 1: Delete events no longer in the scraped set
    const toDelete = existing.filter((r) => !incomingExtIds.has(r.external_id));
    if (toDelete.length > 0) {
      const deleteBatch = db.transaction((rows: typeof toDelete) => {
        const delTags = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
        const delEvent = db.prepare("DELETE FROM events WHERE id = ?");
        for (const row of rows) {
          delTags.run(row.id);
          delEvent.run(row.id);
        }
      });
      deleteBatch(toDelete);
      deleted = toDelete.length;
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
              unchanged++;
              continue;
            }

            const evSlug = uniqueSlug(db, user.id, ev.title, existingRow.id);
            updateEvent.run(
              ev.title, evSlug, ev.description || null,
              ev.startDate, ev.endDate || null, ev.allDay ? 1 : 0,
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
            updated++;
          } else {
            const id = nanoid(16);
            const evSlug = uniqueSlug(db, user.id, ev.title);
            insertEvent.run(
              id, user.id, ev.externalId, evSlug,
              ev.title, ev.description || null,
              ev.startDate, ev.endDate || null, ev.allDay ? 1 : 0,
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

    return c.json({ ok: true, created, updated, unchanged, deleted, total: deduped.length });
  });

  // ─── POST /:id/repost ──────────────────────────────────────────────────

  router.post("/:id/repost", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const event = db.prepare("SELECT id, account_id, visibility FROM events WHERE id = ?").get(id) as
      | { id: string; account_id: string; visibility: string }
      | undefined;
    if (!event) return c.json({ error: "Event not found" }, 404);
    if (event.account_id === user.id) return c.json({ error: "Cannot repost your own event" }, 400);
    if (event.visibility !== "public" && event.visibility !== "unlisted") {
      return c.json({ error: "Can only repost public or unlisted events" }, 403);
    }

    db.prepare("INSERT OR IGNORE INTO reposts (account_id, event_id) VALUES (?, ?)").run(user.id, id);
    return c.json({ ok: true, reposted: true });
  });

  // ─── DELETE /:id/repost ─────────────────────────────────────────────────

  router.delete("/:id/repost", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    db.prepare("DELETE FROM reposts WHERE account_id = ? AND event_id = ?").run(user.id, id);
    return c.json({ ok: true, reposted: false });
  });

  // ─── GET /by-slug/:username/:slug ───────────────────────────────────────

  router.get("/by-slug/:username/:slug", (c) => {
    const username = c.req.param("username");
    const slug = c.req.param("slug");
    const currentUser = c.get("user");

    const event = fetchLocalEvent("a.username = ? AND e.slug = ?", [username, slug], currentUser);
    if (!event) return c.json({ error: "Not found" }, 404);

    return c.json(event);
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

    return c.json({ error: "Not found" }, 404);
  });

  // ─── POST / — create event ─────────────────────────────────────────────

  router.post("/", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{
      title: string;
      description?: string;
      startDate: string;
      endDate?: string;
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
    }>();

    if (!body.title || !body.startDate) {
      return c.json({ error: "Title and startDate are required" }, 400);
    }

    sanitizeEventFields(body as Record<string, unknown>);

    const id = nanoid(16);
    const slug = uniqueSlug(db, user.id, body.title);

    const accountRow = db.prepare("SELECT is_bot, discoverable FROM accounts WHERE id = ?").get(user.id) as
      | { is_bot: number; discoverable: number }
      | undefined;
    const defaultVisibility: EventVisibility =
      accountRow?.is_bot || accountRow?.discoverable ? "public" : "private";
    const visibility = body.visibility || defaultVisibility;

    if (!isValidVisibility(visibility)) {
      return c.json({ error: "Invalid visibility. Must be: public, unlisted, followers_only, or private" }, 400);
    }

    const imageAttributionJson = body.image?.attribution
      ? JSON.stringify(body.image.attribution)
      : null;

    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, description, start_date, end_date, all_day,
        location_name, location_address, location_latitude, location_longitude, location_url,
        image_url, image_media_type, image_alt, image_attribution, url, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, user.id, slug, body.title, body.description || null,
      body.startDate, body.endDate || null, body.allDay ? 1 : 0,
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
      const actorUrl = `${baseUrl}/users/${user.username}`;
      const createActivity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${baseUrl}/events/${id}/activity`,
        type: "Create",
        actor: actorUrl,
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [`${actorUrl}/followers`],
        object: {
          id: `${baseUrl}/events/${id}`,
          type: "Event",
          name: body.title,
          content: body.description || undefined,
          startTime: body.startDate,
          endTime: body.endDate || undefined,
          url: body.url || `${baseUrl}/@${user.username}/${slug}`,
          attributedTo: actorUrl,
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: [`${actorUrl}/followers`],
          published: new Date().toISOString(),
          updated: new Date().toISOString(),
        },
      };
      deliverToFollowers(db, user.id, createActivity).catch(() => {});
    }

    const response = readLocalEventById(id);
    response.rsvpStatus = "going";
    return c.json(response, 201);
  });

  // ─── PUT /:id — update event ───────────────────────────────────────────

  router.put("/:id", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const existing = db
      .prepare("SELECT account_id FROM events WHERE id = ?")
      .get(id) as { account_id: string } | undefined;
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (existing.account_id !== user.id) return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json<{
      title?: string;
      description?: string;
      startDate?: string;
      endDate?: string | null;
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
      const newSlug = uniqueSlug(db, user.id, body.title, id);
      fields.push("slug = ?"); values.push(newSlug);
    }
    if (body.description !== undefined) { fields.push("description = ?"); values.push(body.description || null); }
    if (body.startDate !== undefined) { fields.push("start_date = ?"); values.push(body.startDate); }
    if (body.endDate !== undefined) { fields.push("end_date = ?"); values.push(body.endDate); }
    if (body.allDay !== undefined) { fields.push("all_day = ?"); values.push(body.allDay ? 1 : 0); }
    if (body.visibility !== undefined) {
      if (!isValidVisibility(body.visibility)) {
        return c.json({ error: "Invalid visibility. Must be: public, unlisted, followers_only, or private" }, 400);
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

    return c.json(readLocalEventById(id));
  });

  // ─── DELETE /:id ────────────────────────────────────────────────────────

  router.delete("/:id", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const existing = db
      .prepare("SELECT account_id FROM events WHERE id = ?")
      .get(id) as { account_id: string } | undefined;
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (existing.account_id !== user.id) return c.json({ error: "Forbidden" }, 403);

    db.prepare("DELETE FROM events WHERE id = ?").run(id);

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    const actorUrl = `${baseUrl}/users/${user.username}`;
    const deleteActivity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${baseUrl}/events/${id}/delete`,
      type: "Delete",
      actor: actorUrl,
      object: `${baseUrl}/events/${id}`,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actorUrl}/followers`],
    };
    deliverToFollowers(db, user.id, deleteActivity).catch(() => {});

    return c.json({ ok: true });
  });

  return router;
}
