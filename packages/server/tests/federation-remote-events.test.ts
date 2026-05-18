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

  it("does not change actor_uri on update by default", () => {
    const db = initDatabase(":memory:");
    const originalActorUri = "https://remote.example/users/original";
    const replacementActorUri = "https://remote.example/users/replacement";

    db.prepare(
      `INSERT INTO remote_actors
        (uri, type, preferred_username, display_name, inbox, domain, last_fetched_at)
       VALUES (?, 'Person', 'original', 'Original', 'https://remote.example/inbox', 'remote.example', ?)`
    ).run(originalActorUri, new Date().toISOString());
    db.prepare(
      `INSERT INTO remote_actors
        (uri, type, preferred_username, display_name, inbox, domain, last_fetched_at)
       VALUES (?, 'Person', 'replacement', 'Replacement', 'https://remote.example/inbox', 'remote.example', ?)`
    ).run(replacementActorUri, new Date().toISOString());

    upsertRemoteEvent(
      db,
      {
        id: "https://remote.example/events/ownership-default",
        type: "Event",
        name: "Original owner",
        startTime: "2026-01-15T19:30:00+02:00",
      },
      originalActorUri,
    );
    upsertRemoteEvent(
      db,
      {
        id: "https://remote.example/events/ownership-default",
        type: "Event",
        name: "Attempted owner correction",
        startTime: "2026-01-16T19:30:00+02:00",
      },
      replacementActorUri,
    );

    const row = db.prepare("SELECT actor_uri FROM remote_events WHERE uri = ?").get("https://remote.example/events/ownership-default") as { actor_uri: string } | undefined;
    expect(row?.actor_uri).toBe(originalActorUri);
  });

  it("updates actor_uri when allowActorUriCorrection is true", () => {
    const db = initDatabase(":memory:");
    const originalActorUri = "https://remote.example/users/original";
    const replacementActorUri = "https://remote.example/users/replacement";

    db.prepare(
      `INSERT INTO remote_actors
        (uri, type, preferred_username, display_name, inbox, domain, last_fetched_at)
       VALUES (?, 'Person', 'original', 'Original', 'https://remote.example/inbox', 'remote.example', ?)`
    ).run(originalActorUri, new Date().toISOString());
    db.prepare(
      `INSERT INTO remote_actors
        (uri, type, preferred_username, display_name, inbox, domain, last_fetched_at)
       VALUES (?, 'Person', 'replacement', 'Replacement', 'https://remote.example/inbox', 'remote.example', ?)`
    ).run(replacementActorUri, new Date().toISOString());

    upsertRemoteEvent(
      db,
      {
        id: "https://remote.example/events/ownership-corrected",
        type: "Event",
        name: "Original owner",
        startTime: "2026-01-15T19:30:00+02:00",
      },
      originalActorUri,
    );
    upsertRemoteEvent(
      db,
      {
        id: "https://remote.example/events/ownership-corrected",
        type: "Event",
        name: "Corrected owner",
        startTime: "2026-01-16T19:30:00+02:00",
      },
      replacementActorUri,
      { allowActorUriCorrection: true },
    );

    const row = db.prepare("SELECT actor_uri, title FROM remote_events WHERE uri = ?").get("https://remote.example/events/ownership-corrected") as { actor_uri: string; title: string } | undefined;
    expect(row?.actor_uri).toBe(replacementActorUri);
    expect(row?.title).toBe("Corrected owner");
  });
});
