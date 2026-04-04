import { beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase, type DB } from "../src/db.js";

vi.mock("../src/lib/email.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/email.js")>("../src/lib/email.js");
  return {
    ...actual,
    sendEventReminder: vi.fn().mockResolvedValue(undefined),
    sendEventUpdated: vi.fn().mockResolvedValue(undefined),
    sendEventCancelled: vi.fn().mockResolvedValue(undefined),
  };
});

import { runSendReminders, notifyEventCancelled } from "../src/lib/notifications.js";
import { sendEventCancelled, sendEventReminder } from "../src/lib/email.js";

function isoHoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

describe("notification reminders", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
    vi.mocked(sendEventReminder).mockClear();
    vi.mocked(sendEventCancelled).mockClear();
  });

  it("skips canceled local events when sending reminders", async () => {
    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("owner-1", "owner");
    db.prepare("INSERT INTO accounts (id, username, email, email_verified) VALUES (?, ?, ?, 1)")
      .run("user-1", "attendee", "attendee@example.com");
    db.prepare(
      "INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before) VALUES (?, 1, 24)"
    ).run("user-1");

    const upcomingStart = isoHoursFromNow(2);

    db.prepare(
      `INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, canceled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("event-live", "owner-1", "Live Event", upcomingStart, upcomingStart, "UTC", 0);
    db.prepare(
      `INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, canceled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("event-canceled", "owner-1", "Canceled Event", upcomingStart, upcomingStart, "UTC", 1);

    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("user-1", "event-live");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("user-1", "event-canceled");

    await runSendReminders(db);

    expect(sendEventReminder).toHaveBeenCalledTimes(1);
    const sentEvent = vi.mocked(sendEventReminder).mock.calls[0]?.[1];
    expect(sentEvent?.id).toBe("event-live");

    const sentRows = db
      .prepare("SELECT event_uri FROM event_reminder_sent WHERE account_id = ?")
      .all("user-1") as Array<{ event_uri: string }>;
    expect(sentRows).toEqual([{ event_uri: "event-live" }]);
  });

  it("still sends cancellation notifications to RSVP attendees", async () => {
    db.prepare("INSERT INTO accounts (id, username, email, email_verified) VALUES (?, ?, ?, 1)")
      .run("user-1", "attendee", "attendee@example.com");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("user-1", "event-canceled");

    notifyEventCancelled(db, "event-canceled", {
      id: "event-canceled",
      title: "Canceled Event",
      slug: "canceled-event",
      account: { username: "owner" },
      startDate: isoHoursFromNow(2),
      endDate: null,
      allDay: false,
      location: null,
      url: null,
    });

    await Promise.resolve();

    expect(sendEventCancelled).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEventCancelled).mock.calls[0]?.[0]).toBe("attendee@example.com");
  });
});
