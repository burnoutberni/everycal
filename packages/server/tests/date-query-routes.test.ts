import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { eventRoutes } from "../src/routes/events.js";
import { userRoutes } from "../src/routes/users.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", { ...user, displayName: user.username });
    await next();
  });
  app.route("/api/v1/events", eventRoutes(db));
  app.route("/api/v1/users", userRoutes(db));
  return app;
}

describe("date-query route normalization", () => {
  it("treats date-only to as UTC end-of-day on events list", async () => {
    const db = initDatabase(":memory:");
    const app = makeApp(db);

    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')")
      .run("u1", "alice");
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, start_on, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public')",
    ).run("ev-in", "u1", "ev-in", "Included", "2026-04-13", "2026-04-13T10:00:00.000Z", "UTC", "2026-04-13");
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, start_on, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public')",
    ).run("ev-out", "u1", "ev-out", "Excluded", "2026-04-14", "2026-04-14T00:00:00.000Z", "UTC", "2026-04-14");

    const res = await app.request("http://localhost/api/v1/events?to=2026-04-13");
    expect(res.status).toBe(200);

    const body = await res.json() as { events: Array<{ id: string }> };
    const ids = body.events.map((event) => event.id);
    expect(ids).toContain("ev-in");
    expect(ids).not.toContain("ev-out");
  });

  it("rejects local datetime bounds without offset on events list", async () => {
    const db = initDatabase(":memory:");
    const app = makeApp(db);

    const res = await app.request("http://localhost/api/v1/events?to=2026-04-13T10:00:00");
    expect(res.status).toBe(400);

    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/offset or Z suffix/i);
  });

  it("rejects local datetime bounds without offset on tags route", async () => {
    const db = initDatabase(":memory:");
    const app = makeApp(db);

    const res = await app.request("http://localhost/api/v1/events/tags?from=2026-04-13T10:00:00");
    expect(res.status).toBe(400);

    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/offset or Z suffix/i);
  });

  it("rejects local datetime bounds without offset on timeline route", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    const app = makeApp(db, { id: "u1", username: "alice" });

    const res = await app.request("http://localhost/api/v1/events/timeline?to=2026-04-13T10:00:00");
    expect(res.status).toBe(400);

    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/offset or Z suffix/i);
  });

  it("includes non-UTC all-day local events with date-only bounds", async () => {
    const db = initDatabase(":memory:");
    const app = makeApp(db);

    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')")
      .run("u1", "alice");
    db.prepare(
      `INSERT INTO events (
        id, account_id, slug, title, start_date, all_day,
        start_at_utc, event_timezone, start_on, visibility
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'public')`,
    ).run(
      "ev-vienna",
      "u1",
      "ev-vienna",
      "Vienna All Day",
      "2026-04-01",
      1,
      "2026-03-31T22:00:00.000Z",
      "Europe/Vienna",
      "2026-04-01",
    );

    const eventsRes = await app.request("http://localhost/api/v1/events?from=2026-04-01&to=2026-04-01");
    expect(eventsRes.status).toBe(200);
    const eventsBody = await eventsRes.json() as { events: Array<{ id: string }> };
    expect(eventsBody.events.map((event) => event.id)).toContain("ev-vienna");

    const userEventsRes = await app.request("http://localhost/api/v1/users/alice/events?from=2026-04-01&to=2026-04-01");
    expect(userEventsRes.status).toBe(200);
    const userEventsBody = await userEventsRes.json() as { events: Array<{ id: string }> };
    expect(userEventsBody.events.map((event) => event.id)).toContain("ev-vienna");
  });

  it("includes non-UTC all-day remote events with date-only bounds", async () => {
    const db = initDatabase(":memory:");
    const app = makeApp(db);

    db.prepare(
      `INSERT INTO remote_actors (
        uri, type, preferred_username, inbox, domain
      ) VALUES (?, 'Person', ?, ?, ?)`,
    ).run(
      "https://remote.example/users/anna",
      "anna",
      "https://remote.example/inbox",
      "remote.example",
    );

    db.prepare(
      `INSERT INTO remote_events (
        uri, actor_uri, slug, title, start_date, all_day,
        start_on, start_at_utc, timezone_quality
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offset_only')`,
    ).run(
      "https://remote.example/events/1",
      "https://remote.example/users/anna",
      "remote-event",
      "Remote Vienna All Day",
      "2026-04-01",
      1,
      "2026-04-01",
      "2026-03-31T22:00:00.000Z",
    );

    const res = await app.request("http://localhost/api/v1/events?source=remote&from=2026-04-01&to=2026-04-01");
    expect(res.status).toBe(200);

    const body = await res.json() as { events: Array<{ id: string }> };
    expect(body.events.map((event) => event.id)).toContain("https://remote.example/events/1");
  });
});
