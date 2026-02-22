/**
 * Feed routes — iCal and JSON feed endpoints.
 *
 * GET /api/v1/feeds/:username.ics — iCal feed for an account
 * GET /api/v1/feeds/:username.json — JSON feed for an account
 * GET /api/v1/feeds/calendar-url — Get URL for my calendar feed (auth required)
 * GET /api/v1/feeds/calendar.ics?token=xxx — iCal feed for my calendar (Going/Maybe events)
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../db.js";
import { toICal, type EveryCalEvent } from "@everycal/core";
import { requireAuth } from "../middleware/auth.js";
import { getLocale, t } from "../lib/i18n.js";

function getOrCreateCalendarFeedToken(db: DB, accountId: string): string {
  const row = db
    .prepare("SELECT token FROM calendar_feed_tokens WHERE account_id = ?")
    .get(accountId) as { token: string } | undefined;

  if (row) return row.token;

  const token = `ecal_cal_${nanoid(40)}`;
  db.prepare(
    "INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)"
  ).run(accountId, token);
  return token;
}

function resolveAccountFromCalendarToken(db: DB, token: string): string | null {
  const row = db
    .prepare("SELECT account_id FROM calendar_feed_tokens WHERE token = ?")
    .get(token) as { account_id: string } | undefined;
  return row?.account_id ?? null;
}

export function feedRoutes(db: DB): Hono {
  const router = new Hono();

  // Calendar feed URL (authenticated) — returns the iCal subscription URL
  router.get("/calendar-url", requireAuth(), (c) => {
    const user = c.get("user")!;
    const token = getOrCreateCalendarFeedToken(db, user.id);
    const baseUrl = process.env.BASE_URL || new URL(c.req.url).origin;
    const url = `${baseUrl}/api/v1/feeds/calendar.ics?token=${encodeURIComponent(token)}`;
    return c.json({ url });
  });

  // Calendar feed (token auth) — events user is Going/Maybe to
  router.get("/calendar.ics", (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: t(getLocale(c), "feeds.token_required") }, 400);
    }
    const accountId = resolveAccountFromCalendarToken(db, token);
    if (!accountId) {
      return c.json({ error: t(getLocale(c), "feeds.invalid_token") }, 401);
    }

    // Local events: Going/Maybe (include rsvp_status for tentative); include own events regardless of visibility
    const localRows = db
      .prepare(
        `SELECT e.*, a.username AS account_username, a.display_name AS account_display_name,
                GROUP_CONCAT(DISTINCT t.tag) AS tags, er.status AS rsvp_status
         FROM events e
         JOIN accounts a ON a.id = e.account_id
         JOIN event_rsvps er ON er.event_uri = e.id AND er.account_id = ?
         LEFT JOIN event_tags t ON t.event_id = e.id
         WHERE er.status IN ('going','maybe')
         AND (e.visibility IN ('public','unlisted') OR e.account_id = ?)
         GROUP BY e.id
         ORDER BY e.start_date ASC`
      )
      .all(accountId, accountId) as Record<string, unknown>[];

    // Remote events: Going/Maybe (include rsvp_status for tentative; include canceled)
    const remoteRows = db
      .prepare(
        `SELECT re.uri AS id, re.title, re.description, re.start_date, re.end_date,
                0 AS all_day, re.location_name, re.location_address, re.location_latitude,
                re.location_longitude, re.image_url, re.image_media_type, re.image_alt,
                re.url, re.tags, re.published AS created_at,
                COALESCE(re.updated, re.published, datetime('now')) AS updated_at,
                'public' AS visibility, er.status AS rsvp_status, re.canceled
         FROM remote_events re
         JOIN event_rsvps er ON er.event_uri = re.uri AND er.account_id = ?
         WHERE er.status IN ('going','maybe')
         ORDER BY re.start_date ASC`
      )
      .all(accountId) as Record<string, unknown>[];

    const allRows = [...localRows, ...remoteRows].sort((a, b) => {
      const aDate = (a.start_date as string) || "";
      const bDate = (b.start_date as string) || "";
      return aDate.localeCompare(bDate);
    });

    const vevents = allRows.map((row) => {
      const event = rowToEvent(row);
      const tentative = row.rsvp_status === "maybe";
      const canceled = !!row.canceled;
      return toICal(event, { tentative, canceled });
    });

    const ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//EveryCal//MyCalendar//EN",
      "X-WR-CALNAME:My Calendar",
      ...vevents,
      "END:VCALENDAR",
    ].join("\r\n");

    return c.text(ical, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="my-calendar.ics"',
    });
  });

  router.get("/:file", (c) => {
    const file = c.req.param("file");
    const match = file.match(/^([a-z0-9_]+)\.(ics|json)$/);
    if (!match) return c.json({ error: t(getLocale(c), "feeds.invalid_feed_path") }, 400);

    const [, username, format] = match;

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;

    if (!account) return c.json({ error: t(getLocale(c), "feeds.user_not_found") }, 404);

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
