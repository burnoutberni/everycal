import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/db.js";
import { federationRoutes } from "../src/routes/federation-api.js";
import { upsertRemoteEvent } from "../src/lib/remote-events.js";

describe("federation remote-events serialization", () => {
  it("omits eventTimezone for offset-only remote events", async () => {
    const db = initDatabase(":memory:");
    const actorUri = "https://remote.example/users/alice";

    db.prepare(
      `INSERT INTO remote_actors
        (uri, type, preferred_username, display_name, inbox, domain, last_fetched_at)
       VALUES (?, 'Person', 'alice', 'Alice', 'https://remote.example/inbox', 'remote.example', ?)`
    ).run(actorUri, new Date().toISOString());

    upsertRemoteEvent(
      db,
      {
        id: "https://remote.example/events/offset-only",
        type: "Event",
        name: "Offset-only Event",
        startTime: "2026-01-15T19:30:00+02:00",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
      actorUri,
      {
        temporal: {
          startDate: "2026-01-15T19:30:00+02:00",
          endDate: null,
          allDay: false,
          startAtUtc: "2026-01-15T17:30:00.000Z",
          endAtUtc: null,
          eventTimezone: null,
          timezoneQuality: "offset_only",
        },
      },
    );

    const app = new Hono();
    app.route("/api/v1/federation", federationRoutes(db));

    const res = await app.request(`http://localhost/api/v1/federation/remote-events?actor=${encodeURIComponent(actorUri)}`);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      events: Array<{
        timezoneQuality?: string;
        eventTimezone?: string;
      }>;
    };
    const event = body.events[0];

    expect(event?.timezoneQuality).toBe("offset_only");
    expect(event?.eventTimezone).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(event ?? {}, "eventTimezone")).toBe(false);
  });

  it("trims remote event ids during upsert", () => {
    const db = initDatabase(":memory:");
    const actorUri = "https://remote.example/users/alice";

    db.prepare(
      `INSERT INTO remote_actors
        (uri, type, preferred_username, display_name, inbox, domain, last_fetched_at)
       VALUES (?, 'Person', 'alice', 'Alice', 'https://remote.example/inbox', 'remote.example', ?)`
    ).run(actorUri, new Date().toISOString());

    const first = upsertRemoteEvent(
      db,
      {
        id: "  https://remote.example/events/trim-upsert  ",
        type: "Event",
        name: "First",
        startTime: "2026-01-15T19:30:00+02:00",
      },
      actorUri,
    );
    const second = upsertRemoteEvent(
      db,
      {
        id: "https://remote.example/events/trim-upsert",
        type: "Event",
        name: "Second",
        startTime: "2026-01-15T19:30:00+02:00",
      },
      actorUri,
    );

    expect(first.uri).toBe("https://remote.example/events/trim-upsert");
    expect(second.uri).toBe("https://remote.example/events/trim-upsert");
    const rows = db.prepare("SELECT uri, title FROM remote_events WHERE uri = ?").all("https://remote.example/events/trim-upsert") as Array<{ uri: string; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ uri: "https://remote.example/events/trim-upsert", title: "Second" });
  });
});
