/**
 * Notification logic: reminders, event updates, event cancellations.
 */

import type { DB } from "../db.js";
import {
  sendEventReminder,
  sendEventUpdated,
  sendEventCancelled,
  type EventInfo,
} from "./email.js";

/** Run the reminder job: find events in window, send emails, record sent. */
export async function runSendReminders(db: DB): Promise<void> {
  const now = new Date().toISOString();

  // Local events: account has RSVP, reminder enabled, event in window, not yet sent
  const localRows = db
    .prepare(
      `SELECT a.id AS account_id, a.email, COALESCE(a.preferred_language, 'en') AS preferred_language, anp.reminder_hours_before,
              e.id AS event_uri, e.title, e.start_date, e.end_date, e.all_day,
              e.location_name, e.url
       FROM accounts a
       JOIN account_notification_prefs anp ON anp.account_id = a.id
       JOIN event_rsvps er ON er.account_id = a.id
       JOIN events e ON e.id = er.event_uri
       LEFT JOIN event_reminder_sent ers ON ers.account_id = a.id AND ers.event_uri = e.id
         AND ers.reminder_type = CAST(anp.reminder_hours_before AS TEXT)
       WHERE anp.reminder_enabled = 1
         AND a.email IS NOT NULL AND a.email != ''
         AND a.email_verified = 1
         AND ers.account_id IS NULL
         AND datetime(e.start_date) >= datetime('now')
         AND datetime(e.start_date) <= datetime('now', '+' || anp.reminder_hours_before || ' hours')`
    )
    .all() as {
    account_id: string;
    email: string;
    preferred_language: string;
    reminder_hours_before: number;
    event_uri: string;
    title: string;
    start_date: string;
    end_date: string | null;
    all_day: number;
    location_name: string | null;
    url: string | null;
  }[];

  // Remote events: same logic (exclude canceled)
  const remoteRows = db
    .prepare(
      `SELECT a.id AS account_id, a.email, COALESCE(a.preferred_language, 'en') AS preferred_language, anp.reminder_hours_before,
              re.uri AS event_uri, re.title, re.start_date, re.end_date,
              0 AS all_day, re.location_name, re.url
       FROM accounts a
       JOIN account_notification_prefs anp ON anp.account_id = a.id
       JOIN event_rsvps er ON er.account_id = a.id
       JOIN remote_events re ON re.uri = er.event_uri AND re.canceled = 0
       LEFT JOIN event_reminder_sent ers ON ers.account_id = a.id AND ers.event_uri = re.uri
         AND ers.reminder_type = CAST(anp.reminder_hours_before AS TEXT)
       WHERE anp.reminder_enabled = 1
         AND a.email IS NOT NULL AND a.email != ''
         AND a.email_verified = 1
         AND ers.account_id IS NULL
         AND datetime(re.start_date) >= datetime('now')
         AND datetime(re.start_date) <= datetime('now', '+' || anp.reminder_hours_before || ' hours')`
    )
    .all() as {
    account_id: string;
    email: string;
    preferred_language: string;
    reminder_hours_before: number;
    event_uri: string;
    title: string;
    start_date: string;
    end_date: string | null;
    all_day: number;
    location_name: string | null;
    url: string | null;
  }[];

  const insertSent = db.prepare(
    `INSERT INTO event_reminder_sent (account_id, event_uri, reminder_type) VALUES (?, ?, ?)`
  );

  for (const row of [...localRows, ...remoteRows]) {
    try {
      await sendEventReminder(
        row.email,
        {
          id: row.event_uri,
          title: row.title,
          startDate: row.start_date,
          endDate: row.end_date,
          allDay: !!row.all_day,
          location: row.location_name ? { name: row.location_name } : null,
          url: row.url,
        },
        row.reminder_hours_before,
        row.preferred_language
      );
      insertSent.run(row.account_id, row.event_uri, String(row.reminder_hours_before));
    } catch (err) {
      console.error(`Failed to send reminder to ${row.email}:`, err);
    }
  }
}

/** Get accounts that RSVP'd to an event and have the given pref enabled (default on). */
function getAccountsToNotifyForEvent(
  db: DB,
  eventUri: string,
  prefColumn: "event_updated_enabled" | "event_cancelled_enabled"
): { email: string; preferredLanguage: string }[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.email, COALESCE(a.preferred_language, 'en') AS preferred_language
       FROM accounts a
       JOIN event_rsvps er ON er.account_id = a.id
       LEFT JOIN account_notification_prefs anp ON anp.account_id = a.id
       WHERE er.event_uri = ?
         AND a.email IS NOT NULL AND a.email != ''
         AND a.email_verified = 1
         AND (anp.${prefColumn} = 1 OR anp.account_id IS NULL)`
    )
    .all(eventUri) as { id: string; email: string; preferred_language: string }[];

  return rows
    .filter((r) => r.email)
    .map((r) => ({ email: r.email, preferredLanguage: r.preferred_language }));
}

/** Notify RSVP'd users that an event was updated. Fire-and-forget. */
export function notifyEventUpdated(
  db: DB,
  eventUri: string,
  event: EventInfo,
  changes: string[]
): void {
  const accounts = getAccountsToNotifyForEvent(db, eventUri, "event_updated_enabled");
  for (const { email, preferredLanguage } of accounts) {
    sendEventUpdated(email, event, changes, preferredLanguage).catch((err) =>
      console.error(`Failed to send event-updated to ${email}:`, err)
    );
  }
}

/** Notify RSVP'd users that an event was cancelled. Fire-and-forget. */
export function notifyEventCancelled(db: DB, eventUri: string, event: EventInfo): void {
  const accounts = getAccountsToNotifyForEvent(db, eventUri, "event_cancelled_enabled");
  for (const { email, preferredLanguage } of accounts) {
    sendEventCancelled(email, event, preferredLanguage).catch((err) =>
      console.error(`Failed to send event-cancelled to ${email}:`, err)
    );
  }
}
