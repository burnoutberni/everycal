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

/** Generate a URL-safe slug from a title. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")    // non-alphanum → hyphen
    .replace(/^-+|-+$/g, "")        // trim hyphens
    .slice(0, 80);                   // reasonable length
}

/** Generate a unique slug for an event within an account. */
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

/** Sanitize event input fields to prevent XSS. */
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

export function eventRoutes(db: DB): Hono {
  const router = new Hono();

  // Helper: get a map of event_uri → rsvp status for the current user
  function getUserRsvps(userId: string, eventUris: string[]): Map<string, string> {
    if (eventUris.length === 0) return new Map();
    const placeholders = eventUris.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT event_uri, status FROM event_rsvps WHERE account_id = ? AND event_uri IN (${placeholders})`)
      .all(userId, ...eventUris) as { event_uri: string; status: string }[];
    return new Map(rows.map((r) => [r.event_uri, r.status]));
  }

  // List public events, optionally filtered by account, date range, source, and scope.
  //
  //   source = "local" | "remote" | undefined (both)
  //   scope  = "all" (default) | "mine" (own + followed + RSVP'd) | "calendar" (only going/maybe)
  router.get("/", (c) => {
    const account = c.req.query("account");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const q = c.req.query("q");
    const source = c.req.query("source");
    const scope = c.req.query("scope"); // "mine" | "calendar" | undefined (all)
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const user = c.get("user");
    const isMineScope = scope === "mine" && !!user;
    const isCalendarScope = scope === "calendar" && !!user;

    const localEvents: Record<string, unknown>[] = [];
    const remoteEvents: Record<string, unknown>[] = [];

    // Fetch local events (unless source=remote)
    if (source !== "remote") {
      let sql = `
        SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
               GROUP_CONCAT(DISTINCT t.tag) AS tags
        FROM events e
        JOIN accounts a ON a.id = e.account_id
        LEFT JOIN event_tags t ON t.event_id = e.id
      `;
      const params: unknown[] = [];

      if (isCalendarScope) {
        // Only events I've said Going or Maybe to
        sql += `
          WHERE e.id IN (
            SELECT event_uri FROM event_rsvps
            WHERE account_id = ? AND status IN ('going','maybe')
          )
          AND e.visibility IN ('public','unlisted')
        `;
        params.push(user!.id);
      } else if (isMineScope) {
        const baseUrl = process.env.BASE_URL || "http://localhost:3000";
        const feed = buildFeedQuery({ userId: user!.id, baseUrl });
        sql = feed.sql;
        params.push(...feed.params);
      } else {
        sql += ` WHERE e.visibility = 'public'`;
      }

      const tablePrefix = isMineScope ? "combined" : "e";
      if (account) {
        sql += ` AND a.username = ?`;
        params.push(account);
      }
      if (from) {
        sql += ` AND ${tablePrefix}.start_date >= ?`;
        params.push(from);
      }
      if (to) {
        sql += buildToCondition(`${tablePrefix}.start_date`);
        params.push(...buildToParams(to));
      }
      if (q) {
        sql += ` AND (${tablePrefix}.title LIKE ? OR ${tablePrefix}.description LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`);
      }

      sql += ` GROUP BY ${tablePrefix}.id ORDER BY ${tablePrefix}.start_date ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      localEvents.push(...rows.map((r) => ({ ...formatEvent(r), source: "local" })));
    }

    // Fetch remote events (unless source=local)
    if (source !== "local") {
      let sql = `
        SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
               ra.domain, ra.icon_url AS actor_icon_url
        FROM remote_events re
        LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri
        WHERE 1=1
      `;
      const params: unknown[] = [];

      if (isCalendarScope) {
        // Only remote events I've said Going or Maybe to
        sql += ` AND re.uri IN (
          SELECT event_uri FROM event_rsvps
          WHERE account_id = ? AND status IN ('going','maybe')
        )`;
        params.push(user!.id);
      } else if (isMineScope) {
        // Remote events from actors we follow OR events we've RSVP'd to
        sql += ` AND (
          re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
          OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?)
        )`;
        params.push(user!.id, user!.id);
      }

      if (from) {
        sql += ` AND re.start_date >= ?`;
        params.push(from);
      }
      if (to) {
        sql += buildToCondition("re.start_date");
        params.push(...buildToParams(to));
      }
      if (q) {
        sql += ` AND (re.title LIKE ? OR re.description LIKE ?)`;
        params.push(`%${q}%`, `%${q}%`);
      }

      sql += ` ORDER BY re.start_date ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      remoteEvents.push(...rows.map(formatRemoteEvent));
    }

    // Merge and sort by start date
    let allEvents = [...localEvents, ...remoteEvents]
      .sort((a, b) => {
        const aDate = (a.startDate as string) || "";
        const bDate = (b.startDate as string) || "";
        return aDate.localeCompare(bDate);
      })
      .slice(0, limit);

    // Attach RSVP and repost statuses if user is logged in
    if (user) {
      const uris = allEvents.map((e) => e.id as string);
      const rsvps = getUserRsvps(user.id, uris);

      // Check which events the user has reposted
      const repostedSet = new Set<string>();
      if (uris.length > 0) {
        const placeholders = uris.map(() => "?").join(",");
        const repostRows = db
          .prepare(`SELECT event_id FROM reposts WHERE account_id = ? AND event_id IN (${placeholders})`)
          .all(user.id, ...uris) as { event_id: string }[];
        for (const r of repostRows) repostedSet.add(r.event_id);
      }

      allEvents = allEvents.map((e) => ({
        ...e,
        rsvpStatus: rsvps.get(e.id as string) || null,
        reposted: repostedSet.has(e.id as string),
      }));
    }

    return c.json({ events: allEvents });
  });

  // RSVP — set attendance status for any event (local or remote)
  //   body: { eventUri: string, status: "going" | "maybe" | null }
  //   eventUri = local event ID for local events, or remote event URI for remote events
  //   status = null removes the RSVP
  router.post("/rsvp", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ eventUri: string; status: string | null }>();

    if (!body.eventUri) {
      return c.json({ error: "eventUri is required" }, 400);
    }

    if (body.status === null || body.status === undefined || body.status === "") {
      // Remove RSVP
      db.prepare("DELETE FROM event_rsvps WHERE account_id = ? AND event_uri = ?").run(
        user.id,
        body.eventUri
      );
      return c.json({ ok: true, status: null });
    }

    if (!["going", "maybe"].includes(body.status)) {
      return c.json({ error: "status must be going, maybe, or null" }, 400);
    }

    // Verify the event exists (local or remote)
    const localEvent = db.prepare("SELECT id FROM events WHERE id = ?").get(body.eventUri);
    const remoteEvent = !localEvent
      ? db.prepare("SELECT uri FROM remote_events WHERE uri = ?").get(body.eventUri)
      : null;

    if (!localEvent && !remoteEvent) {
      return c.json({ error: "Event not found" }, 404);
    }

    db.prepare(
      `INSERT INTO event_rsvps (account_id, event_uri, status)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, event_uri) DO UPDATE SET status = excluded.status`
    ).run(user.id, body.eventUri, body.status);

    return c.json({ ok: true, status: body.status });
  });

  // Timeline — legacy endpoint, uses scope=mine logic
  router.get("/timeline", requireAuth(), (c) => {
    const user = c.get("user")!;
    const from = c.req.query("from") || new Date().toISOString();
    const to = c.req.query("to");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const localEvents: Record<string, unknown>[] = [];
    const remoteEvents: Record<string, unknown>[] = [];

    // Local: same feed structure as main events list (uses buildFeedQuery with dateFrom)
    {
      const baseUrl = process.env.BASE_URL || "http://localhost:3000";
      const feed = buildFeedQuery({ userId: user.id, baseUrl, dateFrom: from });
      let sql = feed.sql;
      const params: unknown[] = [...feed.params];
      if (to) {
        sql += buildToCondition("combined.start_date");
        params.push(...buildToParams(to));
      }
      sql += ` GROUP BY combined.id ORDER BY combined.start_date ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      localEvents.push(...rows.map((r) => ({ ...formatEvent(r), source: "local" })));
    }

    // Remote: events from remote actors we follow + RSVP'd
    {
      let sql = `
        SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
               ra.domain, ra.icon_url AS actor_icon_url
        FROM remote_events re
        LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri
        WHERE re.start_date >= ?
          AND (
            re.actor_uri IN (SELECT actor_uri FROM remote_following WHERE account_id = ?)
            OR re.uri IN (SELECT event_uri FROM event_rsvps WHERE account_id = ?)
          )
      `;
      const params: unknown[] = [from, user.id, user.id];
      if (to) { sql += buildToCondition("re.start_date"); params.push(...buildToParams(to)); }
      sql += ` ORDER BY re.start_date ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      remoteEvents.push(...rows.map(formatRemoteEvent));
    }

    let allEvents = [...localEvents, ...remoteEvents]
      .sort((a, b) => ((a.startDate as string) || "").localeCompare((b.startDate as string) || ""))
      .slice(0, limit);

    // Attach RSVPs
    const uris = allEvents.map((e) => e.id as string);
    const rsvps = getUserRsvps(user.id, uris);
    allEvents = allEvents.map((e) => ({ ...e, rsvpStatus: rsvps.get(e.id as string) || null }));

    return c.json({ events: allEvents });
  });

  // Sync events — full replace for a scraper account.
  // Receives an array of events with external IDs. Creates new, updates changed,
  // deletes events that are no longer in the scraped set.
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

    // Validate all events have externalId
    for (const ev of body.events) {
      if (!ev.externalId || !ev.title || !ev.startDate) {
        return c.json({ error: "Each event requires externalId, title, and startDate" }, 400);
      }
    }

    // Deduplicate incoming events by externalId (last one wins)
    const deduped = [...new Map(body.events.map((ev) => [ev.externalId, ev])).values()];

    // Sanitize all event fields
    for (const ev of deduped) {
      sanitizeEventFields(ev as Record<string, unknown>);
    }

    // Get all existing events for this account that have an external_id (including content hash)
    const existing = db
      .prepare("SELECT id, external_id, content_hash FROM events WHERE account_id = ? AND external_id IS NOT NULL")
      .all(user.id) as { id: string; external_id: string; content_hash: string | null }[];

    const existingByExtId = new Map(existing.map((r) => [r.external_id, r]));
    const incomingExtIds = new Set(deduped.map((e) => e.externalId));

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let unchanged = 0;

    /** Compute a stable hash of event content for change detection. */
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

    // Prepare all statements once
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
    const insertTag = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");

    // Helper: yield control back to the event loop so other requests aren't starved
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

    // Batch 2+: Upsert incoming events in chunks — skip unchanged events entirely
    const BATCH_SIZE = 20;
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const chunk = deduped.slice(i, i + BATCH_SIZE);

      const upsertBatch = db.transaction((events: typeof chunk) => {
        for (const ev of events) {
          const visibility = ev.visibility || "public";
          if (!isValidVisibility(visibility)) continue; // skip events with invalid visibility
          const hash = eventHash(ev);
          const existingRow = existingByExtId.get(ev.externalId);

          if (existingRow) {
            // Skip update if content hasn't changed
            if (existingRow.content_hash === hash) {
              unchanged++;
              continue;
            }

            const evSlug = uniqueSlug(db, user.id, ev.title, existingRow.id);
            updateEvent.run(
              ev.title,
              evSlug,
              ev.description || null,
              ev.startDate,
              ev.endDate || null,
              ev.allDay ? 1 : 0,
              ev.location?.name || null,
              ev.location?.address || null,
              ev.location?.latitude ?? null,
              ev.location?.longitude ?? null,
              ev.location?.url || null,
              ev.image?.url || null,
              ev.image?.mediaType || null,
              ev.image?.alt || null,
              ev.url || null,
              visibility,
              hash,
              existingRow.id
            );

            deleteTagsStmt.run(existingRow.id);
            if (ev.tags) {
              for (const tag of ev.tags) insertTag.run(existingRow.id, tag.trim());
            }
            updated++;
          } else {
            const id = nanoid(16);
            const evSlug = uniqueSlug(db, user.id, ev.title);
            insertEvent.run(
              id,
              user.id,
              ev.externalId,
              evSlug,
              ev.title,
              ev.description || null,
              ev.startDate,
              ev.endDate || null,
              ev.allDay ? 1 : 0,
              ev.location?.name || null,
              ev.location?.address || null,
              ev.location?.latitude ?? null,
              ev.location?.longitude ?? null,
              ev.location?.url || null,
              ev.image?.url || null,
              ev.image?.mediaType || null,
              ev.image?.alt || null,
              ev.url || null,
              visibility,
              hash
            );

            if (ev.tags) {
              for (const tag of ev.tags) insertTag.run(id, tag.trim());
            }
            created++;
          }
        }
      });

      upsertBatch(chunk);

      // Yield between batches so the event loop can serve other requests
      if (i + BATCH_SIZE < deduped.length) {
        await yieldToEventLoop();
      }
    }

    return c.json({ ok: true, created, updated, unchanged, deleted, total: deduped.length });
  });

  // Repost an event onto your feed
  router.post("/:id/repost", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    // Verify event exists and is public/unlisted
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

  // Remove repost
  router.delete("/:id/repost", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");
    db.prepare("DELETE FROM reposts WHERE account_id = ? AND event_id = ?").run(user.id, id);
    return c.json({ ok: true, reposted: false });
  });

  // Single event by ID
  // Look up event by username + slug
  router.get("/by-slug/:username/:slug", (c) => {
    const username = c.req.param("username");
    const slug = c.req.param("slug");
    const currentUser = c.get("user");

    const row = db
      .prepare(
        `SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
                GROUP_CONCAT(DISTINCT t.tag) AS tags
         FROM events e
         JOIN accounts a ON a.id = e.account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE a.username = ? AND e.slug = ?
         GROUP BY e.id`
      )
      .get(username, slug) as Record<string, unknown> | undefined;

    if (!row) return c.json({ error: "Not found" }, 404);

    const visibility = row.visibility as string;
    const isOwner = currentUser?.id === row.account_id;

    if (visibility === "private" && !isOwner) {
      return c.json({ error: "Not found" }, 404);
    }
    if (visibility === "followers_only" && !isOwner) {
      const isFollower = currentUser
        ? !!db
            .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
            .get(currentUser.id, row.account_id)
        : false;
      if (!isFollower) return c.json({ error: "Not found" }, 404);
    }

    const event = formatEvent(row);
    if (currentUser) {
      const rsvpRow = db.prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
        .get(currentUser.id, row.id as string) as { status: string } | undefined;
      (event as Record<string, unknown>).rsvpStatus = rsvpRow?.status || null;
      const repostRow = db.prepare("SELECT 1 FROM reposts WHERE account_id = ? AND event_id = ?")
        .get(currentUser.id, row.id as string);
      (event as Record<string, unknown>).reposted = !!repostRow;
    }

    return c.json(event);
  });

  router.get("/:id", (c) => {
    const id = c.req.param("id");
    const currentUser = c.get("user");

    // For remote events, id may be URL-encoded URI or base64url-encoded
    let eventUri = id;
    if (id.startsWith("http")) {
      eventUri = id;
    } else {
      try {
        const decoded = decodeURIComponent(id);
        if (decoded.startsWith("http")) eventUri = decoded;
      } catch {
        // try base64url
        try {
          const decoded = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
          if (decoded.startsWith("http")) eventUri = decoded;
        } catch {
          // use as-is
        }
      }
    }

    let row = db
      .prepare(
        `SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
                GROUP_CONCAT(t.tag) AS tags
         FROM events e
         JOIN accounts a ON a.id = e.account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE e.id = ?
         GROUP BY e.id`
      )
      .get(id) as Record<string, unknown> | undefined;

    // If not found locally and id looks like a URL, try remote_events
    if (!row && (eventUri.startsWith("http://") || eventUri.startsWith("https://"))) {
      const remoteRow = db
        .prepare(
          `SELECT re.*, ra.preferred_username, ra.display_name AS actor_display_name,
                  ra.domain, ra.icon_url AS actor_icon_url
           FROM remote_events re
           LEFT JOIN remote_actors ra ON ra.uri = re.actor_uri
           WHERE re.uri = ?`
        )
        .get(eventUri) as Record<string, unknown> | undefined;

      if (remoteRow) {
        const event = formatRemoteEvent(remoteRow);
        if (currentUser) {
          const rsvpRow = db.prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
            .get(currentUser.id, eventUri) as { status: string } | undefined;
          (event as Record<string, unknown>).rsvpStatus = rsvpRow?.status || null;
        }
        return c.json(event);
      }
    }

    if (!row) return c.json({ error: "Not found" }, 404);

    // Check visibility
    const visibility = row.visibility as string;
    const isOwner = currentUser?.id === row.account_id;

    if (visibility === "private" && !isOwner) {
      return c.json({ error: "Not found" }, 404);
    }
    if (visibility === "followers_only" && !isOwner) {
      const isFollower = currentUser
        ? !!db
            .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
            .get(currentUser.id, row.account_id)
        : false;
      if (!isFollower) return c.json({ error: "Not found" }, 404);
    }

    const event = formatEvent(row);
    if (currentUser) {
      const rsvpRow = db.prepare("SELECT status FROM event_rsvps WHERE account_id = ? AND event_uri = ?")
        .get(currentUser.id, row.id as string) as { status: string } | undefined;
      (event as Record<string, unknown>).rsvpStatus = rsvpRow?.status || null;
      const repostRow = db.prepare("SELECT 1 FROM reposts WHERE account_id = ? AND event_id = ?")
        .get(currentUser.id, row.id as string);
      (event as Record<string, unknown>).reposted = !!repostRow;
    }

    return c.json(event);
  });

  // Create event
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
      image?: { url: string; mediaType?: string; alt?: string };
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
    // Bot/scraper accounts and discoverable accounts default to public; private accounts default to private
    const accountRow = db.prepare("SELECT is_bot, discoverable FROM accounts WHERE id = ?").get(user.id) as { is_bot: number; discoverable: number } | undefined;
    const defaultVisibility: EventVisibility = (accountRow?.is_bot || accountRow?.discoverable) ? "public" : "private";
    const visibility = body.visibility || defaultVisibility;

    if (!isValidVisibility(visibility)) {
      return c.json({ error: "Invalid visibility. Must be: public, unlisted, followers_only, or private" }, 400);
    }

    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, description, start_date, end_date, all_day,
        location_name, location_address, location_latitude, location_longitude, location_url,
        image_url, image_media_type, image_alt, url, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      user.id,
      slug,
      body.title,
      body.description || null,
      body.startDate,
      body.endDate || null,
      body.allDay ? 1 : 0,
      body.location?.name || null,
      body.location?.address || null,
      body.location?.latitude ?? null,
      body.location?.longitude ?? null,
      body.location?.url || null,
      body.image?.url || null,
      body.image?.mediaType || null,
      body.image?.alt || null,
      body.url || null,
      visibility
    );

    // Tags
    if (body.tags && body.tags.length > 0) {
      const insertTag = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");
      for (const tag of body.tags) {
        insertTag.run(id, tag.trim());
      }
    }

    const created = db
      .prepare(
        `SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
                GROUP_CONCAT(t.tag) AS tags
         FROM events e
         JOIN accounts a ON a.id = e.account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE e.id = ?
         GROUP BY e.id`
      )
      .get(id) as Record<string, unknown>;

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

    return c.json(formatEvent(created), 201);
  });

  // Update event
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
      image?: { url: string; mediaType?: string; alt?: string } | null;
      url?: string | null;
      tags?: string[];
      visibility?: string;
    }>();

    sanitizeEventFields(body as Record<string, unknown>);

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.title !== undefined) {
      fields.push("title = ?"); values.push(body.title);
      // Regenerate slug when title changes
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
        fields.push("image_url = NULL, image_media_type = NULL, image_alt = NULL");
      } else {
        fields.push("image_url = ?"); values.push(body.image.url);
        fields.push("image_media_type = ?"); values.push(body.image.mediaType || null);
        fields.push("image_alt = ?"); values.push(body.image.alt || null);
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }

    // Update tags
    if (body.tags !== undefined) {
      db.prepare("DELETE FROM event_tags WHERE event_id = ?").run(id);
      const insertTag = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");
      for (const tag of body.tags) {
        insertTag.run(id, tag.trim());
      }
    }

    const updated = db
      .prepare(
        `SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
                GROUP_CONCAT(t.tag) AS tags
         FROM events e
         JOIN accounts a ON a.id = e.account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE e.id = ?
         GROUP BY e.id`
      )
      .get(id) as Record<string, unknown>;

    return c.json(formatEvent(updated));
  });

  // Delete event
  router.delete("/:id", requireAuth(), (c) => {
    const user = c.get("user")!;
    const id = c.req.param("id");

    const existing = db
      .prepare("SELECT account_id FROM events WHERE id = ?")
      .get(id) as { account_id: string } | undefined;
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (existing.account_id !== user.id) return c.json({ error: "Forbidden" }, 403);

    db.prepare("DELETE FROM events WHERE id = ?").run(id);

    // Deliver Delete to remote followers
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
      ? { url: row.image_url, mediaType: row.image_media_type, alt: row.image_alt }
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
      ? { url: row.image_url, mediaType: row.image_media_type, alt: row.image_alt }
      : null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: "public",
    createdAt: row.published,
    updatedAt: row.updated,
  };
}
