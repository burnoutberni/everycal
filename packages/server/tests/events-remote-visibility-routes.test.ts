import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { eventRoutes } from "../src/routes/events.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", user);
    await next();
  });
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

describe("remote visibility on event listing routes", () => {
  it("filters out private remote events from scope=mine remote listings", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_following (account_id, actor_uri, actor_inbox) VALUES (?, ?, ?)")
      .run("viewer", "https://remote.example/users/alice", "https://remote.example/inbox");

    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/public", "https://remote.example/users/alice", "Public", "2099-01-01", "2099-01-01T00:00:00.000Z", "public");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/followers", "https://remote.example/users/alice", "Followers", "2099-01-02", "2099-01-02T00:00:00.000Z", "followers_only");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/private", "https://remote.example/users/alice", "Private", "2099-01-03", "2099-01-03T00:00:00.000Z", "private");

    const app = makeApp(db, { id: "viewer", username: "viewer" });
    const res = await app.request("http://localhost/api/v1/events?source=remote&scope=mine");
    const body = await res.json() as { events: Array<{ id: string }> };

    expect(res.status).toBe(200);
    const ids = body.events.map((event) => event.id);
    expect(ids).toContain("https://remote.example/events/public");
    expect(ids).toContain("https://remote.example/events/followers");
    expect(ids).not.toContain("https://remote.example/events/private");
  });

  it("filters out private remote events from scope=calendar remote listings", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/bob", "bob", "https://remote.example/inbox", "remote.example");

    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/calendar-public", "https://remote.example/users/bob", "Calendar Public", "2099-02-01", "2099-02-01T00:00:00.000Z", "public");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/calendar-private", "https://remote.example/users/bob", "Calendar Private", "2099-02-02", "2099-02-02T00:00:00.000Z", "private");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')")
      .run("viewer", "https://remote.example/events/calendar-public");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')")
      .run("viewer", "https://remote.example/events/calendar-private");

    const app = makeApp(db, { id: "viewer", username: "viewer" });
    const res = await app.request("http://localhost/api/v1/events?source=remote&scope=calendar");
    const body = await res.json() as { events: Array<{ id: string }> };

    expect(res.status).toBe(200);
    const ids = body.events.map((event) => event.id);
    expect(ids).toContain("https://remote.example/events/calendar-public");
    expect(ids).not.toContain("https://remote.example/events/calendar-private");
  });

  it("does not expose followers-only remote events from RSVP-only access", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/erin", "erin", "https://remote.example/inbox", "remote.example");

    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/calendar-followers", "https://remote.example/users/erin", "Calendar Followers", "2099-02-05", "2099-02-05T00:00:00.000Z", "followers_only");
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, 'going')")
      .run("viewer", "https://remote.example/events/calendar-followers");

    const app = makeApp(db, { id: "viewer", username: "viewer" });
    const res = await app.request("http://localhost/api/v1/events?source=remote&scope=calendar");
    const body = await res.json() as { events: Array<{ id: string }> };

    expect(res.status).toBe(200);
    const ids = body.events.map((event) => event.id);
    expect(ids).not.toContain("https://remote.example/events/calendar-followers");
  });

  it("filters out tags from private remote events for authenticated scopes", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/carol", "carol", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_following (account_id, actor_uri, actor_inbox) VALUES (?, ?, ?)")
      .run("viewer", "https://remote.example/users/carol", "https://remote.example/inbox");

    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility, tags) VALUES (?, ?, ?, ?, ?, 'offset_only', ?, ?)")
      .run("https://remote.example/events/tags-public", "https://remote.example/users/carol", "Tags Public", "2099-03-01", "2099-03-01T00:00:00.000Z", "public", "keepme");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility, tags) VALUES (?, ?, ?, ?, ?, 'offset_only', ?, ?)")
      .run("https://remote.example/events/tags-private", "https://remote.example/users/carol", "Tags Private", "2099-03-02", "2099-03-02T00:00:00.000Z", "private", "leakme");

    const app = makeApp(db, { id: "viewer", username: "viewer" });
    const res = await app.request("http://localhost/api/v1/events/tags?scope=mine");
    const body = await res.json() as { tags: string[] };

    expect(res.status).toBe(200);
    expect(body.tags).toContain("keepme");
    expect(body.tags).not.toContain("leakme");
  });

  it("filters out private remote events from timeline", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/dan", "dan", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_following (account_id, actor_uri, actor_inbox) VALUES (?, ?, ?)")
      .run("viewer", "https://remote.example/users/dan", "https://remote.example/inbox");

    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/timeline-public", "https://remote.example/users/dan", "Timeline Public", "2099-04-01", "2099-04-01T00:00:00.000Z", "public");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality, visibility) VALUES (?, ?, ?, ?, ?, 'offset_only', ?)")
      .run("https://remote.example/events/timeline-private", "https://remote.example/users/dan", "Timeline Private", "2099-04-02", "2099-04-02T00:00:00.000Z", "private");

    const app = makeApp(db, { id: "viewer", username: "viewer" });
    const res = await app.request("http://localhost/api/v1/events/timeline?from=2099-01-01T00:00:00.000Z");
    const body = await res.json() as { events: Array<{ id: string }> };

    expect(res.status).toBe(200);
    const ids = body.events.map((event) => event.id);
    expect(ids).toContain("https://remote.example/events/timeline-public");
    expect(ids).not.toContain("https://remote.example/events/timeline-private");
  });

  it("filters out hidden remote events from listings, direct fetches, and by-slug lookups", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, email_verified) VALUES (?, ?, 1)").run("viewer", "viewer");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/zoe", "zoe", "https://remote.example/inbox", "remote.example");

    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality, visibility, moderation_state) VALUES (?, ?, ?, ?, ?, ?, 'offset_only', ?, ?)")
      .run("https://remote.example/events/visible", "https://remote.example/users/zoe", "visible-event", "Visible", "2099-05-01", "2099-05-01T00:00:00.000Z", "public", "visible");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality, visibility, moderation_state) VALUES (?, ?, ?, ?, ?, ?, 'offset_only', ?, ?)")
      .run("https://remote.example/events/hidden", "https://remote.example/users/zoe", "hidden-event", "Hidden", "2099-05-02", "2099-05-02T00:00:00.000Z", "public", "hidden");

    const app = makeApp(db, { id: "viewer", username: "viewer" });

    const listRes = await app.request("http://localhost/api/v1/events?source=remote");
    const listBody = await listRes.json() as { events: Array<{ id: string }> };
    expect(listRes.status).toBe(200);
    expect(listBody.events.map((event) => event.id)).toContain("https://remote.example/events/visible");
    expect(listBody.events.map((event) => event.id)).not.toContain("https://remote.example/events/hidden");

    const directRes = await app.request(`http://localhost/api/v1/events/${encodeURIComponent("https://remote.example/events/hidden")}`);
    expect(directRes.status).toBe(404);

    const slugRes = await app.request("http://localhost/api/v1/events/by-slug/zoe@remote.example/hidden-event");
    expect(slugRes.status).toBe(404);
  });
});
