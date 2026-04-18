import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/lib/federation.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/federation.js")>("../src/lib/federation.js");
  return {
    ...actual,
    fetchAP: vi.fn(),
    resolveRemoteActor: vi.fn(),
    deliverToFollowers: vi.fn(),
    validateFederationUrl: vi.fn(),
  };
});

vi.mock("../src/lib/notifications.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/notifications.js")>("../src/lib/notifications.js");
  return {
    ...actual,
    notifyEventUpdated: vi.fn(),
    notifyEventCancelled: vi.fn(),
  };
});

vi.mock("../src/routes/og-images.js", async () => {
  const actual = await vi.importActual<typeof import("../src/routes/og-images.js")>("../src/routes/og-images.js");
  return {
    ...actual,
    generateAndSaveOgImage: vi.fn().mockResolvedValue("/og-images/mock.png?v=1"),
    clearLocalOgImage: vi.fn().mockResolvedValue(undefined),
  };
});

import { eventRoutes } from "../src/routes/events.js";
import { userRoutes } from "../src/routes/users.js";
import { upsertRemoteEvent } from "../src/lib/remote-events.js";
import { fetchAP, resolveRemoteActor, deliverToFollowers, validateFederationUrl } from "../src/lib/federation.js";
import { notifyEventUpdated } from "../src/lib/notifications.js";
import { clearLocalOgImage, generateAndSaveOgImage } from "../src/routes/og-images.js";
import { __resetOgJobQueueForTests, __waitForOgJobQueueIdleForTests } from "../src/lib/og-job-queue.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/migrations.js";

const oneYearMs = 365 * 24 * 60 * 60 * 1000;

function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

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

describe("event slug canonical behavior", () => {
  let db: DB;

  beforeEach(() => {
    db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    vi.mocked(fetchAP).mockReset();
    vi.mocked(resolveRemoteActor).mockReset();
    vi.mocked(deliverToFollowers).mockResolvedValue(true as any);
    vi.mocked(validateFederationUrl).mockResolvedValue(undefined);
    vi.mocked(notifyEventUpdated).mockClear();
    vi.mocked(generateAndSaveOgImage).mockClear();
    vi.mocked(clearLocalOgImage).mockClear();
    __resetOgJobQueueForTests();
  });

  it("keeps local slug immutable on title update", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });
    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Original Title", startDate: "2026-01-01T10:00:00Z", eventTimezone: "UTC" }),
    });
    const created = await create.json() as { id: string; slug: string };

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Title" }),
    });
    const updated = await update.json() as { slug: string };

    expect(update.status).toBe(200);
    expect(updated.slug).toBe(created.slug);
  });

  it("detects time change and regenerates OG when PUT uses datetime fields", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Datetime Event",
        startDate: "2026-01-01T10:00:00",
        endDate: "2026-01-01T11:00:00",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    vi.mocked(notifyEventUpdated).mockClear();
    vi.mocked(generateAndSaveOgImage).mockClear();

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startDateTime: "2026-01-01T12:00:00",
        endDateTime: "2026-01-01T13:00:00",
      }),
    });

    expect(update.status).toBe(200);
    expect(notifyEventUpdated).toHaveBeenCalledTimes(1);
    const changes = vi.mocked(notifyEventUpdated).mock.calls[0]?.[3] as Array<{ field: string }> | undefined;
    expect(changes?.some((change) => change.field === "time")).toBe(true);
    expect(generateAndSaveOgImage).toHaveBeenCalledTimes(1);
  });

  it("rejects all-day create when datetime fields are provided", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad All Day",
        allDay: true,
        startDate: "2026-01-01",
        startDateTime: "2026-01-01T12:00:00",
        eventTimezone: "Europe/Vienna",
      }),
    });

    expect(create.status).toBe(400);
  });

  it("rejects all-day create when startDate is not date-only", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad All Day",
        allDay: true,
        startDate: "2026-01-01T12:00:00",
        eventTimezone: "Europe/Vienna",
      }),
    });

    expect(create.status).toBe(400);
  });

  it("stores all-day create as timezone-local midnight UTC instant", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Good All Day",
        allDay: true,
        startDate: "2026-08-10",
        endDate: "2026-08-11",
        eventTimezone: "Europe/Vienna",
      }),
    });

    const body = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const row = db.prepare("SELECT start_date, end_date, start_at_utc, end_at_utc, all_day FROM events WHERE id = ?").get(body.id) as {
      start_date: string;
      end_date: string | null;
      start_at_utc: string;
      end_at_utc: string | null;
      all_day: number;
    };
    expect(row.start_date).toBe("2026-08-10");
    expect(row.end_date).toBe("2026-08-11");
    expect(row.all_day).toBe(1);
    expect(row.start_at_utc).toBe("2026-08-09T22:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-08-11T22:00:00.000Z");
  });

  it("derives all-day create end_at_utc from next day when endDate is omitted", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Single Day All Day",
        allDay: true,
        startDate: "2026-08-10",
        eventTimezone: "Europe/Vienna",
      }),
    });

    const body = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const row = db.prepare("SELECT start_at_utc, end_at_utc FROM events WHERE id = ?").get(body.id) as {
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.start_at_utc).toBe("2026-08-09T22:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-08-10T22:00:00.000Z");
  });

  it("stores timed create start_on/end_on using event local date for absolute instants", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Absolute Instant Create",
        startDate: "2026-01-01T00:30:00Z",
        endDate: "2026-01-01T02:00:00Z",
        eventTimezone: "America/Los_Angeles",
      }),
    });

    const body = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const row = db.prepare(
      "SELECT start_at_utc, end_at_utc, start_on, end_on FROM events WHERE id = ?",
    ).get(body.id) as {
      start_at_utc: string;
      end_at_utc: string | null;
      start_on: string;
      end_on: string | null;
    };
    expect(row.start_at_utc).toBe("2026-01-01T00:30:00.000Z");
    expect(row.end_at_utc).toBe("2026-01-01T02:00:00.000Z");
    expect(row.start_on).toBe("2025-12-31");
    expect(row.end_on).toBe("2025-12-31");
  });

  it("normalizes create temporal values before persistence", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Trimmed Timed Event",
        startDate: "2026-01-01",
        startDateTime: " 2026-01-01T10:00:00 ",
        endDateTime: "   ",
        eventTimezone: "UTC",
      }),
    });

    const body = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const row = db.prepare("SELECT start_date, end_date, start_at_utc, end_at_utc FROM events WHERE id = ?").get(body.id) as {
      start_date: string;
      end_date: string | null;
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.start_date).toBe("2026-01-01T10:00:00");
    expect(row.end_date).toBeNull();
    expect(row.start_at_utc).toBe("2026-01-01T10:00:00.000Z");
    expect(row.end_at_utc).toBeNull();
  });

  it("accepts create with whitespace-padded timezone and stores trimmed value", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Trimmed Timezone Create",
        startDate: "2026-01-01T10:00:00",
        eventTimezone: " UTC ",
      }),
    });

    const body = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const row = db.prepare("SELECT event_timezone FROM events WHERE id = ?").get(body.id) as {
      event_timezone: string;
    };
    expect(row.event_timezone).toBe("UTC");
  });

  it("rejects create when title normalizes to empty whitespace", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "   ",
        startDate: "2026-01-01T10:00:00",
        eventTimezone: "UTC",
      }),
    });

    expect(create.status).toBe(400);
    const row = db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number };
    expect(row.count).toBe(0);
  });

  it("rejects create when title normalizes to empty html", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "<b></b>",
        startDate: "2026-01-01T10:00:00",
        eventTimezone: "UTC",
      }),
    });

    expect(create.status).toBe(400);
    const row = db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number };
    expect(row.count).toBe(0);
  });

  it("does not generate OG for private event creates", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Private Event",
        startDate: "2026-01-01T10:00:00",
        eventTimezone: "UTC",
        visibility: "private",
      }),
    });

    expect(create.status).toBe(201);
    expect(generateAndSaveOgImage).not.toHaveBeenCalled();
  });

  it("rejects switching a timed event to all-day without date-only fields", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Timed Event",
        startDate: "2026-01-01T10:00:00",
        endDate: "2026-01-01T11:00:00",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allDay: true }),
    });

    expect(update.status).toBe(400);
  });

  it("rejects all-day update when datetime fields are provided", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "All Day",
        allDay: true,
        startDate: "2026-01-01",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        allDay: true,
        startDateTime: "2026-01-02T12:00:00",
      }),
    });

    expect(update.status).toBe(400);
  });

  it("accepts switching to all-day when date-only fields are provided", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Timed Event",
        startDate: "2026-03-01T10:00:00",
        endDate: "2026-03-01T12:00:00",
        eventTimezone: "Europe/Vienna",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        allDay: true,
        startDate: "2026-03-01",
        endDate: "2026-03-02",
      }),
    });

    expect(update.status).toBe(200);

    const row = db.prepare("SELECT start_date, end_date, start_at_utc, end_at_utc, all_day FROM events WHERE id = ?").get(created.id) as {
      start_date: string;
      end_date: string | null;
      start_at_utc: string;
      end_at_utc: string | null;
      all_day: number;
    };
    expect(row.start_date).toBe("2026-03-01");
    expect(row.end_date).toBe("2026-03-02");
    expect(row.all_day).toBe(1);
    expect(row.start_at_utc).toBe("2026-02-28T23:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-03-02T23:00:00.000Z");
  });

  it("keeps all-day update end_at_utc end-exclusive when only endDate changes", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "All Day Update Boundary",
        allDay: true,
        startDate: "2026-08-10",
        endDate: "2026-08-11",
        eventTimezone: "Europe/Vienna",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endDate: "2026-08-12" }),
    });
    expect(update.status).toBe(200);

    const row = db.prepare("SELECT start_at_utc, end_at_utc FROM events WHERE id = ?").get(created.id) as {
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.start_at_utc).toBe("2026-08-09T22:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-08-12T22:00:00.000Z");
  });

  it("keeps derived all-day end_at_utc when endDate is explicitly cleared", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "All Day Explicit Clear",
        allDay: true,
        startDate: "2026-08-10",
        endDate: "2026-08-11",
        eventTimezone: "Europe/Vienna",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endDate: null }),
    });
    expect(update.status).toBe(200);

    const row = db.prepare("SELECT end_date, end_at_utc FROM events WHERE id = ?").get(created.id) as {
      end_date: string | null;
      end_at_utc: string | null;
    };
    expect(row.end_date).toBeNull();
    expect(row.end_at_utc).toBe("2026-08-10T22:00:00.000Z");
  });

  it("recomputes timed update start_on/end_on from event timezone when only timezone changes", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Absolute Instant Update",
        startDate: "2026-01-01T00:30:00Z",
        endDate: "2026-01-01T02:00:00Z",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventTimezone: "America/Los_Angeles" }),
    });

    expect(update.status).toBe(200);

    const row = db.prepare(
      "SELECT event_timezone, start_at_utc, end_at_utc, start_on, end_on FROM events WHERE id = ?",
    ).get(created.id) as {
      event_timezone: string;
      start_at_utc: string;
      end_at_utc: string | null;
      start_on: string;
      end_on: string | null;
    };
    expect(row.event_timezone).toBe("America/Los_Angeles");
    expect(row.start_at_utc).toBe("2026-01-01T00:30:00.000Z");
    expect(row.end_at_utc).toBe("2026-01-01T02:00:00.000Z");
    expect(row.start_on).toBe("2025-12-31");
    expect(row.end_on).toBe("2025-12-31");
  });

  it("rejects all-day sync payloads with datetime-shaped startDate", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "all-day-invalid-sync",
            title: "Invalid Sync",
            startDate: "2026-01-01T12:00:00",
            eventTimezone: "UTC",
            allDay: true,
          },
        ],
      }),
    });

    expect(sync.status).toBe(400);
  });

  it("returns a safe 400 for malformed sync temporal field types", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "malformed-sync-1",
            title: "Malformed Sync",
            startDate: 123,
            eventTimezone: "UTC",
          },
        ],
      }),
    });

    const payload = await sync.json() as { error?: unknown };
    expect(sync.status).toBe(400);
    expect(typeof payload.error).toBe("string");
  });

  it("returns a safe 400 for malformed PUT temporal field types", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Malformed PUT",
        startDate: "2026-01-01T10:00:00",
        endDate: "2026-01-01T11:00:00",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startDateTime: 123 }),
    });

    const payload = await update.json() as { error?: unknown };
    expect(update.status).toBe(400);
    expect(typeof payload.error).toBe("string");
  });

  it("treats null startDateTime as omitted on create", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Null datetime create",
        startDate: "2026-01-01T10:00:00",
        startDateTime: null,
        eventTimezone: "UTC",
      }),
    });

    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const row = db.prepare("SELECT start_date FROM events WHERE id = ?").get(created.id) as { start_date: string };
    expect(row.start_date).toBe("2026-01-01T10:00:00");
  });

  it("treats null startDateTime as omitted on update", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Null datetime update",
        startDate: "2026-01-01T10:00:00",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startDate: "2026-01-01T12:00:00",
        startDateTime: null,
      }),
    });

    expect(update.status).toBe(200);

    const row = db.prepare("SELECT start_date FROM events WHERE id = ?").get(created.id) as { start_date: string };
    expect(row.start_date).toBe("2026-01-01T12:00:00");
  });

  it("rejects PUT title update when title normalizes to empty whitespace", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Original PUT Title",
        startDate: "2026-01-01T10:00:00",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });

    expect(update.status).toBe(400);
    const row = db.prepare("SELECT title FROM events WHERE id = ?").get(created.id) as { title: string };
    expect(row.title).toBe("Original PUT Title");
  });

  it("rejects PUT title update when title normalizes to empty html", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const create = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Original PUT HTML Title",
        startDate: "2026-01-01T10:00:00",
        eventTimezone: "UTC",
      }),
    });
    const created = await create.json() as { id: string };
    expect(create.status).toBe(201);

    const update = await app.request(`http://localhost/api/v1/events/${created.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "<b></b>" }),
    });

    expect(update.status).toBe(400);
    const row = db.prepare("SELECT title FROM events WHERE id = ?").get(created.id) as { title: string };
    expect(row.title).toBe("Original PUT HTML Title");
  });

  it("stores all-day sync end_at_utc using end-exclusive boundary", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "all-day-sync-exclusive",
            title: "All Day Sync",
            startDate: "2026-08-10",
            endDate: "2026-08-11",
            eventTimezone: "Europe/Vienna",
            allDay: true,
          },
        ],
      }),
    });

    expect(sync.status).toBe(200);

    const row = db
      .prepare("SELECT all_day, start_at_utc, end_at_utc FROM events WHERE external_id = ?")
      .get("all-day-sync-exclusive") as {
      all_day: number;
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.all_day).toBe(1);
    expect(row.start_at_utc).toBe("2026-08-09T22:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-08-11T22:00:00.000Z");
  });

  it("recomputes all-day sync end_at_utc when inclusive endDate changes", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const firstSync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "all-day-sync-update",
            title: "All Day Sync Update",
            startDate: "2026-08-10",
            endDate: "2026-08-11",
            eventTimezone: "Europe/Vienna",
            allDay: true,
          },
        ],
      }),
    });
    expect(firstSync.status).toBe(200);

    const secondSync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "all-day-sync-update",
            title: "All Day Sync Update",
            startDate: "2026-08-10",
            endDate: "2026-08-12",
            eventTimezone: "Europe/Vienna",
            allDay: true,
          },
        ],
      }),
    });
    expect(secondSync.status).toBe(200);

    const row = db
      .prepare("SELECT start_at_utc, end_at_utc FROM events WHERE external_id = ?")
      .get("all-day-sync-update") as {
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.start_at_utc).toBe("2026-08-09T22:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-08-12T22:00:00.000Z");
  });

  it("stores timed sync start_on/end_on using event local date for absolute instants", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "timed-sync-abs-local-day",
            title: "Timed Sync Absolute",
            startDate: "2026-01-01T00:30:00Z",
            endDate: "2026-01-01T02:00:00Z",
            eventTimezone: "America/Los_Angeles",
          },
        ],
      }),
    });

    expect(sync.status).toBe(200);

    const row = db
      .prepare("SELECT start_at_utc, end_at_utc, start_on, end_on FROM events WHERE external_id = ?")
      .get("timed-sync-abs-local-day") as {
      start_at_utc: string;
      end_at_utc: string | null;
      start_on: string;
      end_on: string | null;
    };
    expect(row.start_at_utc).toBe("2026-01-01T00:30:00.000Z");
    expect(row.end_at_utc).toBe("2026-01-01T02:00:00.000Z");
    expect(row.start_on).toBe("2025-12-31");
    expect(row.end_on).toBe("2025-12-31");
  });

  it("sync only triggers OG generation for public and unlisted events", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "sync-public-og",
            title: "Public OG",
            startDate: "2026-08-10T08:00:00",
            eventTimezone: "UTC",
            visibility: "public",
          },
          {
            externalId: "sync-unlisted-og",
            title: "Unlisted OG",
            startDate: "2026-08-10T09:00:00",
            eventTimezone: "UTC",
            visibility: "unlisted",
          },
          {
            externalId: "sync-private-no-og",
            title: "Private No OG",
            startDate: "2026-08-10T10:00:00",
            eventTimezone: "UTC",
            visibility: "private",
          },
        ],
      }),
    });

    expect(sync.status).toBe(200);
    await __waitForOgJobQueueIdleForTests();

    const publicEvent = db.prepare("SELECT id FROM events WHERE external_id = ?").get("sync-public-og") as { id: string };
    const unlistedEvent = db.prepare("SELECT id FROM events WHERE external_id = ?").get("sync-unlisted-og") as { id: string };
    const privateEvent = db.prepare("SELECT id FROM events WHERE external_id = ?").get("sync-private-no-og") as { id: string };

    const ogCalls = vi.mocked(generateAndSaveOgImage).mock.calls.map((call) => call[1]);
    expect(ogCalls).toContain(publicEvent.id);
    expect(ogCalls).toContain(unlistedEvent.id);
    expect(ogCalls).not.toContain(privateEvent.id);
  });

  it("sync does not trigger OG generation when visibility becomes private", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    db.prepare(
      `INSERT INTO events (
        id, account_id, created_by_account_id, external_id, slug, title,
        start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone,
        start_on, end_on, visibility, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "existing-og",
      "u1",
      "u1",
      "sync-visibility-change",
      "existing-og",
      "Existing OG",
      "2026-08-10T08:00:00",
      null,
      0,
      "2026-08-10T08:00:00.000Z",
      null,
      "UTC",
      "2026-08-10",
      null,
      "public",
      "old-hash",
    );

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "sync-visibility-change",
            title: "Existing OG Updated",
            startDate: "2026-08-10T08:00:00",
            eventTimezone: "UTC",
            visibility: "private",
          },
        ],
      }),
    });

    expect(sync.status).toBe(200);
    await __waitForOgJobQueueIdleForTests();
    expect(generateAndSaveOgImage).not.toHaveBeenCalled();
    expect(clearLocalOgImage).toHaveBeenCalledWith(db, "existing-og");

    const row = db.prepare("SELECT visibility FROM events WHERE id = ?").get("existing-og") as {
      visibility: string;
    };
    expect(row.visibility).toBe("private");
  });

  it("sync responds even when OG generation is still running", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    let releaseOgGeneration: (() => void) | null = null;
    vi.mocked(generateAndSaveOgImage).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseOgGeneration = resolve;
      });
      return "/og-images/mock.png?v=1";
    });

    let responded = false;
    const syncPromise = app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "sync-async-og",
            title: "Async OG",
            startDate: "2026-08-10T08:00:00",
            eventTimezone: "UTC",
            visibility: "public",
          },
        ],
      }),
    }).then((response) => {
      responded = true;
      return response;
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 100);
    });
    expect(responded).toBe(true);

    const sync = await syncPromise;
    expect(sync.status).toBe(200);

    releaseOgGeneration?.();
    await __waitForOgJobQueueIdleForTests();
  });

  it("sync keeps missing past events and only cancels missing future events after a second miss", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });
    const pastStartDate = isoFromNow(-oneYearMs);
    const futureStartDate = isoFromNow(oneYearMs);

    const initialSync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { externalId: "past-1", title: "Past Event", startDate: pastStartDate, eventTimezone: "UTC" },
          { externalId: "future-1", title: "Future Event", startDate: futureStartDate, eventTimezone: "UTC" },
        ],
      }),
    });
    expect(initialSync.status).toBe(200);

    const firstMissing = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    const firstBody = await firstMissing.json() as { canceled: number; rotatedOutPast: number };
    expect(firstMissing.status).toBe(200);
    expect(firstBody.canceled).toBe(0);
    expect(firstBody.rotatedOutPast).toBe(1);

    const secondMissing = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    const secondBody = await secondMissing.json() as { canceled: number; rotatedOutPast: number };
    expect(secondMissing.status).toBe(200);
    expect(secondBody.canceled).toBe(1);
    expect(secondBody.rotatedOutPast).toBe(1);

    const rows = db.prepare("SELECT external_id, canceled FROM events WHERE account_id = ? ORDER BY external_id").all("u1") as Array<{
      external_id: string;
      canceled: number;
    }>;
    expect(rows).toEqual([
      { external_id: "future-1", canceled: 1 },
      { external_id: "past-1", canceled: 0 },
    ]);
  });

  it("sync clears canceled when a previously missing event appears again", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });
    const futureStartDate = isoFromNow(oneYearMs);

    await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ externalId: "future-2", title: "Future Event", startDate: futureStartDate, eventTimezone: "UTC" }],
      }),
    });
    await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });

    const canceledRow = db.prepare("SELECT canceled FROM events WHERE external_id = ?").get("future-2") as { canceled: number };
    expect(canceledRow.canceled).toBe(1);

    const backAgain = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ externalId: "future-2", title: "Future Event", startDate: futureStartDate, eventTimezone: "UTC" }],
      }),
    });
    expect(backAgain.status).toBe(200);

    const restoredRow = db.prepare("SELECT canceled, missing_since FROM events WHERE external_id = ?").get("future-2") as {
      canceled: number;
      missing_since: string | null;
    };
    expect(restoredRow.canceled).toBe(0);
    expect(restoredRow.missing_since).toBeNull();
  });

  it("treats timezone-only sync updates as time changes", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const firstSync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "tz-shift-1",
            title: "Timezone Shift",
            startDate: "2026-06-01T10:00:00",
            endDate: "2026-06-01T11:00:00",
            eventTimezone: "UTC",
          },
        ],
      }),
    });
    expect(firstSync.status).toBe(200);

    vi.mocked(notifyEventUpdated).mockClear();

    const secondSync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "tz-shift-1",
            title: "Timezone Shift",
            startDate: "2026-06-01T10:00:00",
            endDate: "2026-06-01T11:00:00",
            eventTimezone: "Europe/Vienna",
          },
        ],
      }),
    });

    expect(secondSync.status).toBe(200);
    expect(notifyEventUpdated).toHaveBeenCalledTimes(1);
    const changes = vi.mocked(notifyEventUpdated).mock.calls[0]?.[3] as Array<{ field: string }> | undefined;
    expect(changes?.some((change) => change.field === "time")).toBe(true);

    const row = db.prepare("SELECT event_timezone, start_at_utc, end_at_utc FROM events WHERE external_id = ?").get("tz-shift-1") as {
      event_timezone: string;
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.event_timezone).toBe("Europe/Vienna");
    expect(row.start_at_utc).toBe("2026-06-01T08:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-06-01T09:00:00.000Z");
  });

  it("normalizes sync temporal values before persistence", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "trimmed-sync-1",
            title: "Trimmed Sync Event",
            startDate: " 2026-06-01T10:00:00 ",
            endDate: "   ",
            eventTimezone: "UTC",
          },
        ],
      }),
    });
    expect(sync.status).toBe(200);

    const row = db.prepare("SELECT start_date, end_date, start_at_utc, end_at_utc FROM events WHERE external_id = ?").get("trimmed-sync-1") as {
      start_date: string;
      end_date: string | null;
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.start_date).toBe("2026-06-01T10:00:00");
    expect(row.end_date).toBeNull();
    expect(row.start_at_utc).toBe("2026-06-01T10:00:00.000Z");
    expect(row.end_at_utc).toBeNull();
  });

  it("normalizes sync external IDs before dedupe and persistence", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });

    const sync = await app.request("http://localhost/api/v1/events/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          {
            externalId: "sync-ext-trim",
            title: "First Variant",
            startDate: "2026-06-01T10:00:00",
            eventTimezone: "UTC",
          },
          {
            externalId: "  sync-ext-trim  ",
            title: "Second Variant",
            startDate: "2026-06-01T10:00:00",
            eventTimezone: "UTC",
          },
        ],
      }),
    });
    expect(sync.status).toBe(200);

    const payload = await sync.json() as { total: number; created: number };
    expect(payload.total).toBe(1);
    expect(payload.created).toBe(1);

    const row = db.prepare("SELECT external_id, title FROM events WHERE external_id = ?").get("sync-ext-trim") as {
      external_id: string;
      title: string;
    };
    expect(row.external_id).toBe("sync-ext-trim");
    expect(row.title).toBe("Second Variant");

    const countRow = db.prepare("SELECT COUNT(*) AS count FROM events WHERE external_id = ?").get("sync-ext-trim") as {
      count: number;
    };
    expect(countRow.count).toBe(1);
  });

  it("creates remote slug once and keeps it immutable on update", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");

    const first = upsertRemoteEvent(db, {
      id: "https://remote.example/events/1",
      type: "Event",
      name: "Same Event",
      startTime: "2026-01-02T10:00:00Z",
    }, "https://remote.example/users/alice");

    const second = upsertRemoteEvent(db, {
      id: "https://remote.example/events/1",
      type: "Event",
      name: "Changed Name",
      startTime: "2026-01-02T10:00:00Z",
    }, "https://remote.example/users/alice");

    expect(first.slug).toBe("same-event");
    expect(second.slug).toBe("same-event");
  });

  it("persists missing slug on remote update with actor-scoped uniqueness", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("https://remote.example/events/other", "https://remote.example/users/alice", "same-event", "Same Event", "2026-01-02T10:00:00Z", "2026-01-02T10:00:00Z", "offset_only");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality) VALUES (?, ?, ?, ?, ?, ?)")
      .run("https://remote.example/events/target", "https://remote.example/users/alice", "Same Event", "2026-01-02T10:00:00Z", "2026-01-02T10:00:00Z", "offset_only");

    const updated = upsertRemoteEvent(db, {
      id: "https://remote.example/events/target",
      type: "Event",
      name: "Same Event",
      startTime: "2026-01-03T10:00:00Z",
    }, "https://remote.example/users/alice");

    expect(updated.slug).toBe("same-event-2");
    const row = db.prepare("SELECT slug FROM remote_events WHERE uri = ?").get("https://remote.example/events/target") as { slug: string };
    expect(row.slug).toBe("same-event-2");
  });

  it("preserves canceled flag on generic remote refresh, but allows explicit clear", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality, canceled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
      .run("https://remote.example/events/c1", "https://remote.example/users/alice", "cancelled-event", "Cancelled Event", "2026-01-02T10:00:00Z", "2026-01-02T10:00:00Z", "offset_only");

    upsertRemoteEvent(db, {
      id: "https://remote.example/events/c1",
      type: "Event",
      name: "Cancelled Event",
      startTime: "2026-01-02T10:00:00Z",
    }, "https://remote.example/users/alice");

    const preserved = db.prepare("SELECT canceled FROM remote_events WHERE uri = ?").get("https://remote.example/events/c1") as { canceled: number };
    expect(preserved.canceled).toBe(1);

    upsertRemoteEvent(db, {
      id: "https://remote.example/events/c1",
      type: "Event",
      name: "Cancelled Event",
      startTime: "2026-01-02T10:00:00Z",
    }, "https://remote.example/users/alice", { clearCanceled: true });

    const cleared = db.prepare("SELECT canceled FROM remote_events WHERE uri = ?").get("https://remote.example/events/c1") as { canceled: number };
    expect(cleared.canceled).toBe(0);
  });

  it("stores inferred all-day semantics for remote date-only events", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");

    upsertRemoteEvent(db, {
      id: "https://remote.example/events/day-1",
      type: "Event",
      name: "Date Only",
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      eventTimezone: "Europe/Vienna",
    }, "https://remote.example/users/alice");

    const row = db.prepare("SELECT all_day, start_at_utc, end_at_utc FROM remote_events WHERE uri = ?").get("https://remote.example/events/day-1") as {
      all_day: number;
      start_at_utc: string;
      end_at_utc: string | null;
    };
    expect(row.all_day).toBe(1);
    expect(row.start_at_utc).toBe("2026-08-09T22:00:00.000Z");
    expect(row.end_at_utc).toBe("2026-08-11T22:00:00.000Z");
  });

  it("stores remote start_on/end_on using event local date for exact timezone absolute instants", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");

    upsertRemoteEvent(db, {
      id: "https://remote.example/events/exact-date-parts",
      type: "Event",
      name: "Exact TZ Date Parts",
      startTime: "2026-01-01T00:30:00.000Z",
      endTime: "2026-01-01T01:30:00.000Z",
      eventTimezone: "America/Los_Angeles",
    }, "https://remote.example/users/alice");

    const row = db.prepare(
      "SELECT start_on, end_on, start_at_utc, end_at_utc, event_timezone, timezone_quality FROM remote_events WHERE uri = ?"
    ).get("https://remote.example/events/exact-date-parts") as {
      start_on: string;
      end_on: string;
      start_at_utc: string;
      end_at_utc: string | null;
      event_timezone: string | null;
      timezone_quality: string;
    };

    expect(row.start_at_utc).toBe("2026-01-01T00:30:00.000Z");
    expect(row.end_at_utc).toBe("2026-01-01T01:30:00.000Z");
    expect(row.event_timezone).toBe("America/Los_Angeles");
    expect(row.timezone_quality).toBe("exact_tzid");
    expect(row.start_on).toBe("2025-12-31");
    expect(row.end_on).toBe("2025-12-31");
  });

  it("handles remote slug collisions per actor", () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/bob", "bob", "https://remote.example/inbox", "remote.example");

    const a1 = upsertRemoteEvent(db, { id: "https://remote.example/events/a1", type: "Event", name: "Party", startTime: "2026-01-02T10:00:00Z" }, "https://remote.example/users/alice");
    const a2 = upsertRemoteEvent(db, { id: "https://remote.example/events/a2", type: "Event", name: "Party", startTime: "2026-01-03T10:00:00Z" }, "https://remote.example/users/alice");
    const b1 = upsertRemoteEvent(db, { id: "https://remote.example/events/b1", type: "Event", name: "Party", startTime: "2026-01-04T10:00:00Z" }, "https://remote.example/users/bob");

    expect(a1.slug).toBe("party");
    expect(a2.slug).toBe("party-2");
    expect(b1.slug).toBe("party");
  });

  it("/events/by-slug/:username/:slug resolves local and remote", async () => {
    db.prepare("INSERT INTO events (id, account_id, slug, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, 'public')")
      .run("e-local", "u1", "local-slug", "Local", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z", "UTC");
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("https://remote.example/events/1", "https://remote.example/users/alice", "remote-slug", "Remote", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z", "offset_only");

    const app = makeApp(db, { id: "u1", username: "alice" });
    const localRes = await app.request("http://localhost/api/v1/events/by-slug/alice/local-slug");
    const remoteRes = await app.request("http://localhost/api/v1/events/by-slug/alice@remote.example/remote-slug");

    expect(localRes.status).toBe(200);
    expect(remoteRes.status).toBe(200);
    expect((await remoteRes.json() as { source: string }).source).toBe("remote");
  });

  it("/users/:username/events returns remote canonical temporal fields", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, timezone_quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "https://remote.example/events/1",
        "https://remote.example/users/alice",
        "remote-slug",
        "Remote",
        "2026-01-01T11:00:00+01:00",
        "2026-01-01T12:30:00+01:00",
        0,
        "2026-01-01T10:00:00.000Z",
        "2026-01-01T11:30:00.000Z",
        "Europe/Vienna",
        "exact_tzid"
      );

    const app = makeApp(db, { id: "u1", username: "alice" });
    const res = await app.request("http://localhost/api/v1/users/alice@remote.example/events");
    const body = await res.json() as {
      events: Array<{
        source: string;
        slug?: string;
        allDay?: boolean;
        startAtUtc?: string;
        endAtUtc?: string | null;
        eventTimezone?: string;
        timezoneQuality?: "exact_tzid" | "offset_only";
      }>;
    };

    expect(res.status).toBe(200);
    expect(body.events[0]?.source).toBe("remote");
    expect(body.events[0]?.slug).toBe("remote-slug");
    expect(body.events[0]?.allDay).toBe(false);
    expect(body.events[0]?.startAtUtc).toBe("2026-01-01T10:00:00.000Z");
    expect(body.events[0]?.endAtUtc).toBe("2026-01-01T11:30:00.000Z");
    expect(body.events[0]?.eventTimezone).toBe("Europe/Vienna");
    expect(body.events[0]?.timezoneQuality).toBe("exact_tzid");
  });

  it("/users/:username/events returns local canonical temporal fields", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public')"
    ).run(
      "e-local-canonical",
      "u1",
      "local-canonical",
      "Local Timed",
      "2026-02-15T18:00:00",
      "2026-02-15T19:15:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "2026-02-15T18:15:00.000Z",
      "Europe/Vienna"
    );

    const app = makeApp(db, { id: "u1", username: "alice" });
    const res = await app.request("http://localhost/api/v1/users/alice/events");
    const body = await res.json() as {
      events: Array<{
        source?: string;
        slug?: string;
        allDay?: boolean;
        startAtUtc?: string;
        endAtUtc?: string | null;
        eventTimezone?: string;
        timezoneQuality?: "exact_tzid" | "offset_only";
      }>;
    };

    expect(res.status).toBe(200);
    const event = body.events.find((e) => e.slug === "local-canonical");
    expect(event?.source).toBeUndefined();
    expect(event?.allDay).toBe(false);
    expect(event?.startAtUtc).toBe("2026-02-15T17:00:00.000Z");
    expect(event?.endAtUtc).toBe("2026-02-15T18:15:00.000Z");
    expect(event?.eventTimezone).toBe("Europe/Vienna");
    expect(event?.timezoneQuality).toBe("exact_tzid");
  });

  it("normalizes local eventTimezone in API responses when legacy row has invalid timezone", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, all_day, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public')"
    ).run(
      "e-invalid-timezone",
      "u1",
      "invalid-timezone",
      "Legacy Invalid TZ",
      "2026-02-15T18:00:00",
      0,
      "2026-02-15T18:00:00.000Z",
      "Not/AZone"
    );

    const app = makeApp(db, { id: "u1", username: "alice" });
    const res = await app.request("http://localhost/api/v1/events/e-invalid-timezone");
    const body = await res.json() as { eventTimezone?: string; timezoneQuality?: string };

    expect(res.status).toBe(200);
    expect(body.eventTimezone).toBe("UTC");
    expect(body.timezoneQuality).toBe("exact_tzid");
  });

  it("normalizes local eventTimezone in editable by-slug responses when legacy row has blank timezone", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, all_day, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public')"
    ).run(
      "e-missing-timezone",
      "u1",
      "missing-timezone",
      "Legacy Missing TZ",
      "2026-03-20T18:00:00",
      0,
      "2026-03-20T18:00:00.000Z",
      ""
    );

    const app = makeApp(db, { id: "u1", username: "alice" });
    const res = await app.request("http://localhost/api/v1/events/by-slug/alice/missing-timezone");
    const body = await res.json() as { source?: string; eventTimezone?: string; timezoneQuality?: string };

    expect(res.status).toBe(200);
    expect(body.source).toBe("local");
    expect(body.eventTimezone).toBe("UTC");
    expect(body.timezoneQuality).toBe("exact_tzid");
  });

  it("heals invalid stored timezone to UTC on write when eventTimezone is omitted", async () => {
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, all_day, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public')"
    ).run(
      "e-heal-timezone",
      "u1",
      "heal-timezone",
      "Legacy Invalid TZ",
      "2026-02-15T18:00:00",
      0,
      "2026-02-15T18:00:00.000Z",
      "Not/AZone"
    );

    const app = makeApp(db, { id: "u1", username: "alice" });
    const res = await app.request("http://localhost/api/v1/events/e-heal-timezone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    const body = await res.json() as { eventTimezone?: string };
    const row = db.prepare("SELECT event_timezone FROM events WHERE id = ?").get("e-heal-timezone") as { event_timezone: string };

    expect(res.status).toBe(200);
    expect(body.eventTimezone).toBe("UTC");
    expect(row.event_timezone).toBe("UTC");
  });

  it("resolver bootstraps unfetched remote event and returns canonical path", async () => {
    vi.mocked(fetchAP).mockResolvedValue({
      id: "https://remote.example/events/99",
      type: "Event",
      name: "Resolver Event",
      startTime: "2026-01-01T10:00:00Z",
      attributedTo: "https://remote.example/users/alice",
    });
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/alice",
      preferred_username: "alice",
      display_name: "Alice",
      inbox: "https://remote.example/inbox",
      domain: "remote.example",
    } as any);

    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fremote.example%2Fevents%2F99");
    const body = await res.json() as { path: string };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/@alice@remote.example/resolver-event");
  });

  it("resolver redirects to canonical path for browser navigations", async () => {
    vi.mocked(fetchAP).mockResolvedValue({
      id: "https://remote.example/events/100",
      type: "Event",
      name: "Resolver Redirect Event",
      startTime: "2026-01-01T10:00:00Z",
      attributedTo: "https://remote.example/users/alice",
    });
    vi.mocked(resolveRemoteActor).mockResolvedValue({
      uri: "https://remote.example/users/alice",
      preferred_username: "alice",
      display_name: "Alice",
      inbox: "https://remote.example/inbox",
      domain: "remote.example",
    } as any);

    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fremote.example%2Fevents%2F100", {
      headers: { accept: "text/html" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/@alice@remote.example/resolver-redirect-event");
  });

  it("resolver returns controlled 502 on remote fetch failures", async () => {
    vi.mocked(fetchAP).mockRejectedValue(new Error("upstream timeout"));
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fremote.example%2Fevents%2F100");
    const body = await res.json() as { error: string };

    expect(res.status).toBe(502);
    expect(body.error).toContain("Failed to resolve remote event");
  });

  it("resolver returns deterministic 400 for blocked federation URLs", async () => {
    vi.mocked(validateFederationUrl).mockRejectedValueOnce(new Error("Requests to private/internal addresses are not allowed"));
    const app = makeApp(db);
    const res = await app.request("http://localhost/api/v1/events/resolve?uri=http%3A%2F%2F127.0.0.1%2Fevents%2F100");
    const body = await res.json() as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("private/internal");
  });

  it("resolver assigns slug for existing cached remote event without slug", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://events.htu.at/users/htu", "htu", "https://events.htu.at/inbox", "events.htu.at");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, title, start_date, start_at_utc, timezone_quality) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "https://events.htu.at/events/13064e2e-f644-4b7d-8421-c280ad93b066",
        "https://events.htu.at/users/htu",
        "HTU Event",
        "2026-01-01T10:00:00Z",
        "2026-01-01T10:00:00Z",
        "offset_only",
      );

    const app = makeApp(db);
    const res = await app.request(
      "http://localhost/api/v1/events/resolve?uri=https%3A%2F%2Fevents.htu.at%2Fevents%2F13064e2e-f644-4b7d-8421-c280ad93b066"
    );
    const body = await res.json() as { path: string };

    expect(res.status).toBe(200);
    expect(body.path).toBe("/@htu@events.htu.at/htu-event");
    expect(vi.mocked(fetchAP)).not.toHaveBeenCalled();
  });

  it("old base64 remote route is no longer supported", async () => {
    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare("INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, start_at_utc, timezone_quality) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("https://remote.example/events/1", "https://remote.example/users/alice", "remote-slug", "Remote", "2026-01-01T10:00:00Z", "2026-01-01T10:00:00Z", "offset_only");

    const oldId = Buffer.from("https://remote.example/events/1").toString("base64url");
    const app = makeApp(db);
    const res = await app.request(`http://localhost/api/v1/events/${oldId}`);
    expect(res.status).toBe(404);
  });

  it("adopts the schema version marker for an already-current database", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "current.sqlite");
    const initial = initDatabase(dbPath);
    initial.pragma("user_version = 0");
    initial.close();

    const reopened = initDatabase(dbPath);
    const userVersion = reopened.pragma("user_version", { simple: true }) as number;
    expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);

    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("assumes unsupported legacy schemas are current and marks schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE remote_events (
        uri TEXT PRIMARY KEY,
        actor_uri TEXT NOT NULL,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL
      );
    `);
    legacy.close();

    const reopened = initDatabase(dbPath);
    const userVersion = reopened.pragma("user_version", { simple: true }) as number;
    expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
