import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";

vi.mock("../src/lib/federation.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/federation.js")>("../src/lib/federation.js");
  return {
    ...actual,
    fetchAP: vi.fn(),
    resolveRemoteActor: vi.fn(),
    deliverActivity: vi.fn(),
    deliverToFollowers: vi.fn().mockResolvedValue(true),
    validateFederationUrl: vi.fn(),
  };
});

import { eventRoutes } from "../src/routes/events.js";
import { activityPubRoutes, activityPubEventRoutes } from "../src/routes/activitypub.js";
import { deliverToFollowers } from "../src/lib/federation.js";

function makeApp(db: DB, user: { id: string; username: string } | null = null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (user) c.set("user", { ...user, displayName: user.username });
    await next();
  });
  app.route("/api/v1/events", eventRoutes(db));
  app.route("/users", activityPubRoutes(db));
  app.route("/events", activityPubEventRoutes(db));
  return app;
}

describe("ActivityPub timezone interoperability", () => {
  let db: DB;

  beforeEach(() => {
    process.env.SKIP_SIGNATURE_VERIFY = "true";
    db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    vi.mocked(deliverToFollowers).mockClear();
  });

  it("emits Create payload times as UTC Z with eventTimezone extension", async () => {
    const app = makeApp(db, { id: "u1", username: "alice" });
    const res = await app.request("http://localhost/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "UTC Outbound",
        startDate: "2026-03-01T10:00:00",
        endDate: "2026-03-01T11:00:00",
        eventTimezone: "Europe/Vienna",
        visibility: "public",
      }),
    });

    expect(res.status).toBe(201);
    const payload = vi.mocked(deliverToFollowers).mock.calls[0]?.[2] as Record<string, any>;
    expect(payload.object.startTime).toBe("2026-03-01T09:00:00.000Z");
    expect(payload.object.endTime).toBe("2026-03-01T10:00:00.000Z");
    expect(payload.object.eventTimezone).toBe("Europe/Vienna");
    expect(Array.isArray(payload["@context"])).toBe(true);
  });

  it("serves federated Event objects with UTC times and context extension", async () => {
    db.prepare(
      `INSERT INTO events (id, account_id, slug, title, start_date, end_date, start_at_utc, end_at_utc, event_timezone, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'public')`
    ).run(
      "e1",
      "u1",
      "event-one",
      "Event One",
      "2026-03-01T10:00:00",
      "2026-03-01T11:00:00",
      "2026-03-01T09:00:00.000Z",
      "2026-03-01T10:00:00.000Z",
      "Europe/Vienna",
    );

    const app = makeApp(db);
    const res = await app.request("http://localhost/events/e1", {
      headers: { accept: "application/activity+json" },
    });
    const body = await res.json() as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.startTime).toBe("2026-03-01T09:00:00.000Z");
    expect(body.endTime).toBe("2026-03-01T10:00:00.000Z");
    expect(body.eventTimezone).toBe("Europe/Vienna");
    expect(Array.isArray(body["@context"])).toBe(true);
  });

  it("ingests inbound AP timezone quality variants", async () => {
    const app = makeApp(db);
    const actor = "https://remote.example/users/a";

    const exact = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Create",
        actor,
        object: {
          id: "https://remote.example/events/exact",
          type: "Event",
          name: "Exact",
          startTime: "2026-03-01T09:00:00Z",
          eventTimezone: "Europe/Vienna",
          attributedTo: actor,
        },
      }),
    });
    expect(exact.status).toBe(202);

    const offset = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Create",
        actor,
        object: {
          id: "https://remote.example/events/offset",
          type: "Event",
          name: "Offset",
          startTime: "2026-03-01T10:00:00+01:00",
          attributedTo: actor,
        },
      }),
    });
    expect(offset.status).toBe(202);

    const unknown = await app.request("http://localhost/users/alice/inbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Create",
        actor,
        object: {
          id: "https://remote.example/events/unknown",
          type: "Event",
          name: "Unknown",
          startTime: "2026-03-01T10:00:00",
          attributedTo: actor,
        },
      }),
    });
    expect(unknown.status).toBe(202);

    const exactRow = db.prepare(
      "SELECT start_at_utc, event_timezone, timezone_quality FROM remote_events WHERE uri = ?"
    ).get("https://remote.example/events/exact") as { start_at_utc: string; event_timezone: string; timezone_quality: string };
    expect(exactRow.start_at_utc).toBe("2026-03-01T09:00:00.000Z");
    expect(exactRow.event_timezone).toBe("Europe/Vienna");
    expect(exactRow.timezone_quality).toBe("exact_tzid");

    const offsetRow = db.prepare(
      "SELECT start_at_utc, event_timezone, timezone_quality FROM remote_events WHERE uri = ?"
    ).get("https://remote.example/events/offset") as { start_at_utc: string; event_timezone: string | null; timezone_quality: string };
    expect(offsetRow.start_at_utc).toBe("2026-03-01T09:00:00.000Z");
    expect(offsetRow.event_timezone).toBeNull();
    expect(offsetRow.timezone_quality).toBe("offset_only");

    const unknownRow = db.prepare(
      "SELECT start_at_utc, event_timezone, timezone_quality FROM remote_events WHERE uri = ?"
    ).get("https://remote.example/events/unknown") as { start_at_utc: string | null; event_timezone: string | null; timezone_quality: string };
    expect(unknownRow.start_at_utc).toBeNull();
    expect(unknownRow.event_timezone).toBeNull();
    expect(unknownRow.timezone_quality).toBe("unknown");
  });
});
