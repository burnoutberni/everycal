/**
 * Feed routes — iCal and JSON feed endpoints.
 *
 * GET /api/v1/feeds/:username.ics — iCal feed for an account
 * GET /api/v1/feeds/:username.json — JSON feed for an account
 */

import { Hono } from "hono";
import type { DB } from "../db.js";
import { toICal, type EveryCalEvent } from "@everycal/core";

export function feedRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/:file", (c) => {
    const file = c.req.param("file");
    const match = file.match(/^([a-z0-9_]+)\.(ics|json)$/);
    if (!match) return c.json({ error: "Invalid feed path. Use :username.ics or :username.json (only lowercase letters, numbers, and underscores allowed in username)" }, 400);

    const [, username, format] = match;

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;

    if (!account) return c.json({ error: "User not found" }, 404);

    // Own public events + explicit reposts + auto-reposted events
    const rows = db
      .prepare(
        `SELECT * FROM (
          -- Own events
          SELECT e.*, GROUP_CONCAT(DISTINCT t.tag) AS tags,
                 NULL AS repost_username,
                 NULL AS repost_display_name,
                 a_orig.username AS account_username,
                 a_orig.display_name AS account_display_name
          FROM events e
          LEFT JOIN event_tags t ON t.event_id = e.id
          JOIN accounts a_orig ON a_orig.id = e.account_id
          WHERE e.account_id = ?
            AND e.visibility = 'public'
          GROUP BY e.id

          UNION ALL

          -- Explicit reposts
          SELECT e.*, GROUP_CONCAT(DISTINCT t.tag) AS tags,
                 ra.username AS repost_username,
                 ra.display_name AS repost_display_name,
                 a_orig.username AS account_username,
                 a_orig.display_name AS account_display_name
          FROM reposts r
          JOIN events e ON e.id = r.event_id
          JOIN accounts ra ON ra.id = r.account_id
          JOIN accounts a_orig ON a_orig.id = e.account_id
          LEFT JOIN event_tags t ON t.event_id = e.id
          WHERE r.account_id = ?
            AND e.visibility IN ('public','unlisted')
          GROUP BY e.id

          UNION ALL

          -- Auto-reposted events
          SELECT e.*, GROUP_CONCAT(DISTINCT t.tag) AS tags,
                 ra.username AS repost_username,
                 ra.display_name AS repost_display_name,
                 a_orig.username AS account_username,
                 a_orig.display_name AS account_display_name
          FROM auto_reposts ar
          JOIN events e ON e.account_id = ar.source_account_id
          JOIN accounts ra ON ra.id = ar.account_id
          JOIN accounts a_orig ON a_orig.id = e.account_id
          LEFT JOIN event_tags t ON t.event_id = e.id
          WHERE ar.account_id = ?
            AND e.visibility = 'public'
            AND e.account_id != ?
            AND e.id NOT IN (SELECT event_id FROM reposts WHERE account_id = ?)
          GROUP BY e.id
        ) ORDER BY start_date ASC`
      )
      .all(account.id, account.id, account.id, account.id, account.id);

    if (format === "json") {
      return c.json({ events: rows });
    }

    // iCal format
    const vevents = rows.map((row) => {
      const event = rowToEvent(row as Record<string, unknown>);
      return toICal(event);
    });

    const ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:-//EveryCal//${username}//EN`,
      `X-WR-CALNAME:${username}`,
      ...vevents,
      "END:VCALENDAR",
    ].join("\r\n");

    return c.text(ical, 200, { "Content-Type": "text/calendar; charset=utf-8" });
  });

  return router;
}

function rowToEvent(row: Record<string, unknown>): EveryCalEvent {
  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    startDate: row.start_date as string,
    endDate: row.end_date as string | undefined,
    allDay: !!row.all_day,
    location: row.location_name
      ? {
          name: row.location_name as string,
          address: row.location_address as string | undefined,
          latitude: row.location_latitude as number | undefined,
          longitude: row.location_longitude as number | undefined,
          url: row.location_url as string | undefined,
        }
      : undefined,
    image: row.image_url
      ? {
          url: row.image_url as string,
          mediaType: row.image_media_type as string | undefined,
          alt: row.image_alt as string | undefined,
        }
      : undefined,
    url: row.url as string | undefined,
    tags: row.tags ? (row.tags as string).split(",") : undefined,
    visibility: row.visibility as "public",
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
