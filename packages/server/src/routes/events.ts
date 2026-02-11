/**
 * Event API routes.
 *
 * GET /api/v1/events?account=:username&from=:iso&to=:iso — list public events
 * GET /api/v1/events/:id — single event
 * POST /api/v1/events — create event (auth required, TODO)
 */

import { Hono } from "hono";
import type { DB } from "../db.js";

export function eventRoutes(db: DB): Hono {
  const router = new Hono();

  // List public events, optionally filtered by account and date range
  router.get("/", (c) => {
    const account = c.req.query("account");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let sql = `
      SELECT e.*, GROUP_CONCAT(t.tag) AS tags
      FROM events e
      LEFT JOIN event_tags t ON t.event_id = e.id
      WHERE e.visibility = 'public'
    `;
    const params: unknown[] = [];

    if (account) {
      sql += ` AND e.account_id = (SELECT id FROM accounts WHERE username = ?)`;
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

    sql += ` GROUP BY e.id ORDER BY e.start_date ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return c.json({ events: rows.map(formatEvent) });
  });

  // Single event by ID
  router.get("/:id", (c) => {
    const id = c.req.param("id");
    const row = db
      .prepare(
        `SELECT e.*, GROUP_CONCAT(t.tag) AS tags
         FROM events e
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE e.id = ? AND e.visibility = 'public'
         GROUP BY e.id`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(formatEvent(row));
  });

  return router;
}

function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
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
        }
      : null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
