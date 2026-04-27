import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/db.js";
import { privateFeedRoutes } from "../src/routes/private-feeds.js";
import { hashTokenSecret } from "../src/lib/token-secrets.js";

describe("calendar feed timezone output", () => {
  it("emits timezone-rich ICS for local and remote events", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)").run("u1", hashTokenSecret("tok1"));

    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, start_date, end_date, start_at_utc, end_at_utc, event_timezone, all_day, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public')`
    ).run(
      "e-local",
      "u1",
      "local-event",
      "Local TZ Event",
      "2026-03-01T10:00:00",
      "2026-03-01T11:00:00",
      "2026-03-01T09:00:00.000Z",
      "2026-03-01T10:00:00.000Z",
      "Europe/Vienna",
      0,
    );

    db.prepare(
      `INSERT INTO remote_actors (uri, preferred_username, inbox, domain)
       VALUES (?, ?, ?, ?)`
    ).run("https://remote.example/users/bob", "bob", "https://remote.example/inbox", "remote.example");
    db.prepare(
      `INSERT INTO remote_events (uri, actor_uri, title, start_date, end_date, start_at_utc, end_at_utc, timezone_quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "https://remote.example/events/r1",
      "https://remote.example/users/bob",
      "Remote UTC Event",
      "2026-03-02T09:00:00Z",
      "2026-03-02T10:00:00Z",
      "2026-03-02T09:00:00.000Z",
      "2026-03-02T10:00:00.000Z",
      "offset_only",
    );

    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "e-local");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "https://remote.example/events/r1");

    const app = new Hono();
    app.route("/api/v1/private-feeds", privateFeedRoutes(db));

    const res = await app.request("http://localhost/api/v1/private-feeds/calendar.ics?token=tok1");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("BEGIN:VTIMEZONE");
    expect(text).toContain("TZID:Europe/Vienna");
    expect(text).toContain("DTSTART;TZID=Europe/Vienna:20260301T100000");
    expect(text).toContain("DTSTART:20260302T090000Z");
  });
});
