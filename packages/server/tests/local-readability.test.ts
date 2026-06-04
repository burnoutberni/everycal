import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { hashTokenSecret } from "../src/lib/token-secrets.js";
import { eventRoutes } from "../src/routes/events.js";
import { privateFeedRoutes } from "../src/routes/private-feeds.js";

function makeEventApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", { ...user, displayName: user.username });
    await next();
  });
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

describe("local readability across private and calendar surfaces", () => {
  it("hides hidden local RSVP'd events from private calendar feeds", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)").run("u1", hashTokenSecret("tok1"));

    db.prepare(
      `INSERT INTO events (
        id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility, moderation_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`
    ).run("visible-local", "u1", "visible-local", "Visible Local Event", "2099-06-01", "2099-06-01T00:00:00.000Z", "UTC", "visible");
    db.prepare(
      `INSERT INTO events (
        id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility, moderation_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`
    ).run("hidden-local", "u1", "hidden-local", "Hidden Local Event", "2099-06-02", "2099-06-02T00:00:00.000Z", "UTC", "hidden");

    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "visible-local");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("u1", "hidden-local");

    const app = new Hono();
    app.route("/api/v1/private-feeds", privateFeedRoutes(db));

    const res = await app.request("http://localhost/api/v1/private-feeds/calendar.ics?token=tok1");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).toContain("Visible Local Event");
    expect(text).not.toContain("Hidden Local Event");
  });

  it("filters out tags from hidden local calendar and mine scopes", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type, email_verified) VALUES (?, ?, 'person', 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("owner", "owner");
    db.prepare("INSERT INTO follows (follower_id, following_id) VALUES (?, ?)").run("viewer", "owner");

    db.prepare(
      `INSERT INTO events (
        id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility, moderation_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`
    ).run("visible-local", "owner", "visible-local", "Visible Local Event", "2099-07-01", "2099-07-01T00:00:00.000Z", "UTC", "visible");
    db.prepare(
      `INSERT INTO events (
        id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility, moderation_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`
    ).run("hidden-local", "owner", "hidden-local", "Hidden Local Event", "2099-07-02", "2099-07-02T00:00:00.000Z", "UTC", "hidden");
    db.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, ?), (?, ?)").run("visible-local", "keepme", "hidden-local", "leakme");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("viewer", "visible-local");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')").run("viewer", "hidden-local");

    const app = makeEventApp(db, { id: "viewer", username: "viewer" });

    const calendarRes = await app.request("http://localhost/api/v1/events/tags?scope=calendar");
    const calendarBody = await calendarRes.json() as { tags: string[] };
    expect(calendarRes.status).toBe(200);
    expect(calendarBody.tags).toContain("keepme");
    expect(calendarBody.tags).not.toContain("leakme");

    const mineRes = await app.request("http://localhost/api/v1/events/tags?scope=mine");
    const mineBody = await mineRes.json() as { tags: string[] };
    expect(mineRes.status).toBe(200);
    expect(mineBody.tags).toContain("keepme");
    expect(mineBody.tags).not.toContain("leakme");
  });
});
