/**
 * Event API routes.
 *
 * GET  /api/v1/events                — list public events
 * GET  /api/v1/events/timeline       — events from people you follow
 * GET  /api/v1/events/:id            — single event
 * POST /api/v1/events                — create event (auth)
 * POST /api/v1/events/sync           — sync events for scraper accounts (auth)
 * PUT  /api/v1/events/:id            — update event (auth, owner only)
 * DELETE /api/v1/events/:id          — delete event (auth, owner only)
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

export function eventRoutes(db: DB): Hono {
  const router = new Hono();

  // List public events, optionally filtered by account and date range
  router.get("/", (c) => {
    const account = c.req.query("account");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const q = c.req.query("q");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let sql = `
      SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
             GROUP_CONCAT(t.tag) AS tags
      FROM events e
      JOIN accounts a ON a.id = e.account_id
      LEFT JOIN event_tags t ON t.event_id = e.id
      WHERE e.visibility = 'public'
    `;
    const params: unknown[] = [];

    if (account) {
      sql += ` AND a.username = ?`;
      params.push(account);
    }
    if (from) {
      sql += ` AND e.start_date >= ?`;
      params.push(from);
    }
    if (to) {
      sql += ` AND e.start_date <= ?`;
      params.push(to);
    }
    if (q) {
      sql += ` AND (e.title LIKE ? OR e.description LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
    }

    sql += ` GROUP BY e.id ORDER BY e.start_date ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return c.json({ events: rows.map(formatEvent) });
  });

  // Timeline — events from people you follow + your own
  router.get("/timeline", requireAuth(), (c) => {
    const user = c.get("user")!;
    const from = c.req.query("from") || new Date().toISOString();
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const rows = db
      .prepare(
        `SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
                GROUP_CONCAT(t.tag) AS tags
         FROM events e
         JOIN accounts a ON a.id = e.account_id
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE e.start_date >= ?
           AND (
             (e.account_id = ? AND e.visibility IN ('public','unlisted','followers_only','private'))
             OR
             (e.account_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
              AND e.visibility IN ('public','unlisted','followers_only'))
           )
         GROUP BY e.id
         ORDER BY e.start_date ASC
         LIMIT ? OFFSET ?`
      )
      .all(from, user.id, user.id, limit, offset) as Record<string, unknown>[];

    return c.json({ events: rows.map(formatEvent) });
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

    // Get all existing events for this account that have an external_id
    const existing = db
      .prepare("SELECT id, external_id FROM events WHERE account_id = ? AND external_id IS NOT NULL")
      .all(user.id) as { id: string; external_id: string }[];

    const existingByExtId = new Map(existing.map((r) => [r.external_id, r.id]));
    const incomingExtIds = new Set(body.events.map((e) => e.externalId));

    let created = 0;
    let updated = 0;
    let deleted = 0;

    const syncTransaction = db.transaction(() => {
      // Delete events no longer in the scraped set
      const toDelete = existing.filter((r) => !incomingExtIds.has(r.external_id));
      if (toDelete.length > 0) {
        const deleteTags = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
        const deleteEvent = db.prepare("DELETE FROM events WHERE id = ?");
        for (const row of toDelete) {
          deleteTags.run(row.id);
          deleteEvent.run(row.id);
        }
        deleted = toDelete.length;
      }

      // Upsert each incoming event
      const insertEvent = db.prepare(
        `INSERT INTO events (id, account_id, external_id, title, description, start_date, end_date, all_day,
          location_name, location_address, location_latitude, location_longitude, location_url,
          image_url, image_media_type, image_alt, url, visibility)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const updateEvent = db.prepare(
        `UPDATE events SET title = ?, description = ?, start_date = ?, end_date = ?, all_day = ?,
          location_name = ?, location_address = ?, location_latitude = ?, location_longitude = ?, location_url = ?,
          image_url = ?, image_media_type = ?, image_alt = ?, url = ?, visibility = ?,
          updated_at = datetime('now')
         WHERE id = ?`
      );

      const deleteTags = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
      const insertTag = db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?)");

      for (const ev of body.events) {
        const visibility = ev.visibility || "public";
        const existingId = existingByExtId.get(ev.externalId);

        if (existingId) {
          // Update
          updateEvent.run(
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
            existingId
          );

          // Replace tags
          deleteTags.run(existingId);
          if (ev.tags) {
            for (const tag of ev.tags) insertTag.run(existingId, tag.trim());
          }
          updated++;
        } else {
          // Insert
          const id = nanoid(16);
          insertEvent.run(
            id,
            user.id,
            ev.externalId,
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
            visibility
          );

          if (ev.tags) {
            for (const tag of ev.tags) insertTag.run(id, tag.trim());
          }
          created++;
        }
      }
    });

    syncTransaction();

    return c.json({ ok: true, created, updated, deleted, total: body.events.length });
  });

  // Single event by ID
  router.get("/:id", (c) => {
    const id = c.req.param("id");
    const currentUser = c.get("user");

    const row = db
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

    return c.json(formatEvent(row));
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

    const id = nanoid(16);
    const visibility = body.visibility || "public";

    db.prepare(
      `INSERT INTO events (id, account_id, title, description, start_date, end_date, all_day,
        location_name, location_address, location_latitude, location_longitude, location_url,
        image_url, image_media_type, image_alt, url, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      user.id,
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

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.title !== undefined) { fields.push("title = ?"); values.push(body.title); }
    if (body.description !== undefined) { fields.push("description = ?"); values.push(body.description || null); }
    if (body.startDate !== undefined) { fields.push("start_date = ?"); values.push(body.startDate); }
    if (body.endDate !== undefined) { fields.push("end_date = ?"); values.push(body.endDate); }
    if (body.allDay !== undefined) { fields.push("all_day = ?"); values.push(body.allDay ? 1 : 0); }
    if (body.visibility !== undefined) { fields.push("visibility = ?"); values.push(body.visibility); }
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
    return c.json({ ok: true });
  });

  return router;
}

function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
