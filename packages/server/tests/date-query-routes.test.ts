import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { eventRoutes } from "../src/routes/events.js";

function makeApp(db: DB) {
  const app = new Hono();
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

describe("date-query route normalization", () => {
  it("treats date-only to as UTC end-of-day on events list", async () => {
    const db = initDatabase(":memory:");
    const app = makeApp(db);

    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')")
      .run("u1", "alice");
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, 'public')",
    ).run("ev-in", "u1", "ev-in", "Included", "2026-04-13", "2026-04-13T10:00:00.000Z", "UTC");
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, 'public')",
    ).run("ev-out", "u1", "ev-out", "Excluded", "2026-04-14", "2026-04-14T00:00:00.000Z", "UTC");

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
});
