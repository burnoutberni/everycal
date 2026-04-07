/**
 * Feed routes — iCal and JSON feed endpoints.
 *
 * GET /api/v1/feeds/:username.ics — iCal feed for an account
 * GET /api/v1/feeds/:username.json — JSON feed for an account
 */

import { Hono, type Context } from "hono";
import type { DB } from "../db.js";
import { toICalendar } from "@everycal/core";
import { getLocale, t } from "../lib/i18n.js";
import { isValidIdentityHandle } from "../lib/handles.js";
import { rowToEvent } from "../lib/feed-event.js";

function setPublicFeedCacheHeaders(c: Context): void {
  c.header("Cache-Control", "public, max-age=300, s-maxage=900, stale-while-revalidate=300");
}

export function feedRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/:file", (c) => {
    const file = c.req.param("file");
    const match = file.match(/^(.+)\.(ics|json)$/);
    if (!match) return c.json({ error: t(getLocale(c), "feeds.invalid_feed_path") }, 400);

    const [, username, format] = match;
    if (!isValidIdentityHandle(username)) {
      return c.json({ error: t(getLocale(c), "feeds.invalid_feed_path") }, 400);
    }

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
        ) ORDER BY start_at_utc ASC`
      )
      .all(account.id, account.id, account.id, account.id, account.id);

    setPublicFeedCacheHeaders(c);

    if (format === "json") {
      return c.json({ events: rows });
    }

    // iCal format
    const entries = rows.map((row) => {
      const event = rowToEvent(row as Record<string, unknown>);
      return { event };
    });
    const ical = toICalendar(entries, {
      prodId: `-//EveryCal//${username}//EN`,
      calendarName: username,
    });

    return c.text(ical, 200, { "Content-Type": "text/calendar; charset=utf-8" });
  });

  return router;
}
