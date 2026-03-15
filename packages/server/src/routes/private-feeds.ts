/**
 * Private feed routes — authenticated or tokenized calendar feeds.
 *
 * GET /api/v1/private-feeds/calendar-url — Get URL for my calendar feed (auth required)
 * GET /api/v1/private-feeds/calendar.ics?token=xxx — iCal feed for my calendar (Going/Maybe events)
 */

import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../db.js";
import { toICalendar } from "@everycal/core";
import { requireAuth } from "../middleware/auth.js";
import { getLocale, t } from "../lib/i18n.js";
import { rowToEvent } from "../lib/feed-event.js";

function getOrCreateCalendarFeedToken(db: DB, accountId: string): string {
  const token = `ecal_cal_${nanoid(40)}`;
  db.prepare(
    "INSERT OR IGNORE INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)"
  ).run(accountId, token);

  const row = db
    .prepare("SELECT token FROM calendar_feed_tokens WHERE account_id = ?")
    .get(accountId) as { token: string } | undefined;

  if (!row) {
    throw new Error("Failed to resolve calendar feed token");
  }

  return row.token;
}

function resolveAccountFromCalendarToken(db: DB, token: string): string | null {
  const row = db
    .prepare("SELECT account_id FROM calendar_feed_tokens WHERE token = ?")
    .get(token) as { account_id: string } | undefined;
  return row?.account_id ?? null;
}

function setPrivateNoStoreHeaders(c: Context): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
}

export function privateFeedRoutes(db: DB): Hono {
  const router = new Hono();

  const privateNoStore = async (c: Context, next: () => Promise<void>) => {
    setPrivateNoStoreHeaders(c);
    await next();
  };

  // Calendar feed URL (authenticated) — returns the iCal subscription URL
  router.get("/calendar-url", privateNoStore, requireAuth(), (c) => {
    const user = c.get("user")!;
    const token = getOrCreateCalendarFeedToken(db, user.id);
    const baseUrl = process.env.BASE_URL || new URL(c.req.url).origin;
    const url = `${baseUrl}/api/v1/private-feeds/calendar.ics?token=${encodeURIComponent(token)}`;
    return c.json({ url });
  });

  // Calendar feed (token auth) — events user is Going/Maybe to
  router.get("/calendar.ics", (c) => {
    setPrivateNoStoreHeaders(c);
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
                re.start_at_utc, re.end_at_utc, re.event_timezone, re.timezone_quality,
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

    const entries = allRows.map((row) => {
      const event = rowToEvent(row);
      const tentative = row.rsvp_status === "maybe";
      const canceled = !!row.canceled;
      return { event, options: { tentative, canceled } };
    });
    const ical = toICalendar(entries, {
      prodId: "-//EveryCal//MyCalendar//EN",
      calendarName: "My Calendar",
    });

    return c.text(ical, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="my-calendar.ics"',
    });
  });

  return router;
}
