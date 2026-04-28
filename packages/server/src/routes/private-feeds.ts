/**
 * Private feed routes — authenticated or tokenized calendar feeds.
 *
 * GET /api/v1/private-feeds/calendar-url — Get URL for my calendar feed (auth required)
 * POST /api/v1/private-feeds/calendar-url/regenerate — Rotate calendar feed URL token (auth required)
 * GET /api/v1/private-feeds/calendar.ics?token=xxx — iCal feed for my calendar (Going/Maybe events)
 */

import { Hono, type Context } from "hono";
import crypto from "node:crypto";
import type { DB } from "../db.js";
import { toICalendar } from "@everycal/core";
import { requireAuth } from "../middleware/auth.js";
import { getLocale, t } from "../lib/i18n.js";
import { rowToEvent } from "../lib/feed-event.js";
import { findByTokenHash } from "../lib/token-secrets.js";

const CALENDAR_FEED_TOKEN_PREFIX = "ecal_cal_";
const DEV_CALENDAR_FEED_TOKEN_SECRET = "everycal-dev-calendar-feed-token-secret";
const CALENDAR_FEED_TOKEN_VERSION = "v1";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function getCalendarFeedTokenSecret(): string {
  const configured = process.env.CALENDAR_FEED_TOKEN_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("CALENDAR_FEED_TOKEN_SECRET must be set in production");
  }
  return DEV_CALENDAR_FEED_TOKEN_SECRET;
}

function signCalendarFeedPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function getCalendarFeedTokenVersion(db: DB, accountId: string): number {
  const row = db
    .prepare("SELECT calendar_feed_token_version FROM accounts WHERE id = ?")
    .get(accountId) as { calendar_feed_token_version?: number } | undefined;
  if (!row || typeof row.calendar_feed_token_version !== "number" || row.calendar_feed_token_version < 1) {
    return 1;
  }
  return row.calendar_feed_token_version;
}

function buildCalendarFeedToken(accountId: string, version: number, secret: string): string {
  const payload = encodeBase64Url(JSON.stringify({ a: accountId, v: version, k: CALENDAR_FEED_TOKEN_VERSION }));
  const signature = signCalendarFeedPayload(payload, secret);
  return `${CALENDAR_FEED_TOKEN_PREFIX}${payload}.${signature}`;
}

function parseSignedCalendarFeedToken(token: string): { accountId: string; version: number } | null {
  if (!token.startsWith(CALENDAR_FEED_TOKEN_PREFIX)) return null;
  const signed = token.slice(CALENDAR_FEED_TOKEN_PREFIX.length);
  const separator = signed.lastIndexOf(".");
  if (separator <= 0 || separator === signed.length - 1) return null;

  const payload = signed.slice(0, separator);
  const providedSignature = signed.slice(separator + 1);
  const secret = getCalendarFeedTokenSecret();
  const expectedSignature = signCalendarFeedPayload(payload, secret);
  if (!timingSafeEqual(providedSignature, expectedSignature)) return null;

  const decoded = decodeBase64Url(payload);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as { a?: string; v?: number; k?: string };
    if (parsed.k !== CALENDAR_FEED_TOKEN_VERSION) return null;
    if (typeof parsed.a !== "string" || typeof parsed.v !== "number") return null;
    if (!Number.isInteger(parsed.v) || parsed.v < 1) return null;
    return { accountId: parsed.a, version: parsed.v };
  } catch {
    return null;
  }
}

function getOrCreateCalendarFeedToken(db: DB, accountId: string): string {
  const version = getCalendarFeedTokenVersion(db, accountId);
  const secret = getCalendarFeedTokenSecret();
  return buildCalendarFeedToken(accountId, version, secret);
}

function regenerateCalendarFeedToken(db: DB, accountId: string): string {
  const rotate = db.transaction((id: string) => {
    db.prepare("UPDATE accounts SET calendar_feed_token_version = calendar_feed_token_version + 1 WHERE id = ?").run(id);
    db.prepare("DELETE FROM calendar_feed_tokens WHERE account_id = ?").run(id);
  });
  rotate(accountId);
  return getOrCreateCalendarFeedToken(db, accountId);
}

function resolveAccountFromCalendarToken(db: DB, token: string): string | null {
  const signed = parseSignedCalendarFeedToken(token);
  if (signed) {
    const row = db
      .prepare("SELECT id FROM accounts WHERE id = ? AND calendar_feed_token_version = ?")
      .get(signed.accountId, signed.version) as { id: string } | undefined;
    if (row?.id) return row.id;
    return null;
  }

  const row = findByTokenHash<{ account_id: string }>(
    db,
    "SELECT account_id FROM calendar_feed_tokens WHERE token = ?",
    token
  );
  return row?.account_id ?? null;
}

function setPrivateNoStoreHeaders(c: Context): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
}

export function privateFeedRoutes(db: DB): Hono {
  getCalendarFeedTokenSecret();
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

  router.post("/calendar-url/regenerate", privateNoStore, requireAuth(), (c) => {
    const user = c.get("user")!;
    const token = regenerateCalendarFeedToken(db, user.id);
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
         ORDER BY e.start_at_utc ASC`
      )
      .all(accountId, accountId) as Record<string, unknown>[];

    // Remote events: Going/Maybe (include rsvp_status for tentative; include canceled)
    const remoteRows = db
      .prepare(
         `SELECT re.uri AS id, re.title, re.description, re.start_date, re.end_date,
                re.start_at_utc, re.end_at_utc, re.event_timezone, re.timezone_quality,
                re.all_day AS all_day, re.location_name, re.location_address, re.location_latitude,
                re.location_longitude, re.image_url, re.image_media_type, re.image_alt,
                re.url, re.tags, re.published AS created_at,
                COALESCE(re.updated, re.published, datetime('now')) AS updated_at,
                'public' AS visibility, er.status AS rsvp_status, re.canceled
         FROM remote_events re
         JOIN event_rsvps er ON er.event_uri = re.uri AND er.account_id = ?
         WHERE er.status IN ('going','maybe')
         ORDER BY re.start_at_utc ASC`
      )
      .all(accountId) as Record<string, unknown>[];

    const allRows = [...localRows, ...remoteRows].sort((a, b) => {
      const aDate = (a.start_at_utc as string) || "";
      const bDate = (b.start_at_utc as string) || "";
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
