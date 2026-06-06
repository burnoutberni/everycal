import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { initDatabase, type DB } from "../src/db.js";
import { getSsrInitialData } from "../src/lib/ssr-data.js";
import { eventRoutes } from "../src/routes/events.js";

function makeApp(db: DB) {
  const app = new Hono();
  app.route("/api/v1/events", eventRoutes(db));
  return app;
}

function canonicalFields(event: Record<string, unknown> | null | undefined) {
  return {
    startAtUtc: event?.startAtUtc,
    endAtUtc: event?.endAtUtc,
    eventTimezone: event?.eventTimezone,
    timezoneQuality: event?.timezoneQuality,
  };
}

describe("SSR event payload canonical temporal fields", () => {
  it("includes canonical fields for local timed events", () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");
    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public')"
    ).run(
      "e-local-ssr",
      "u1",
      "local-ssr",
      "Local SSR",
      "2026-02-15T18:00:00",
      "2026-02-15T19:15:00",
      0,
      "2026-02-15T17:00:00.000Z",
      "2026-02-15T18:15:00.000Z",
      "Europe/Vienna"
    );

    const data = getSsrInitialData(db, "/@alice/local-ssr", null);
    expect(data?.kind).toBe("event");
    const event = data && data.kind === "event" ? data.event as Record<string, unknown> : null;
    expect(canonicalFields(event)).toEqual({
      startAtUtc: "2026-02-15T17:00:00.000Z",
      endAtUtc: "2026-02-15T18:15:00.000Z",
      eventTimezone: "Europe/Vienna",
      timezoneQuality: "exact_tzid",
    });
  });

  it("matches API canonical fields for local and remote event payloads", async () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("u1", "alice");

    db.prepare(
      "INSERT INTO events (id, account_id, slug, title, start_date, all_day, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public')"
    ).run(
      "e-local-parity",
      "u1",
      "local-parity",
      "Local Parity",
      "2026-04-01T09:00:00",
      0,
      "2026-04-01T07:00:00.000Z",
      "Europe/Vienna"
    );

    db.prepare("INSERT INTO remote_actors (uri, preferred_username, inbox, domain) VALUES (?, ?, ?, ?)")
      .run("https://remote.example/users/alice", "alice", "https://remote.example/inbox", "remote.example");
    db.prepare(
      "INSERT INTO remote_events (uri, actor_uri, slug, title, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, timezone_quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "https://remote.example/events/1",
      "https://remote.example/users/alice",
      "remote-parity",
      "Remote Parity",
      "2026-04-02T11:00:00+01:00",
      "2026-04-02T12:30:00+01:00",
      0,
      "2026-04-02T10:00:00.000Z",
      "2026-04-02T11:30:00.000Z",
      "Europe/Vienna",
      "exact_tzid"
    );

    const app = makeApp(db);

    const ssrLocal = getSsrInitialData(db, "/@alice/local-parity", null);
    const apiLocalRes = await app.request("http://localhost/api/v1/events/by-slug/alice/local-parity");
    const apiLocal = await apiLocalRes.json() as Record<string, unknown>;
    const ssrLocalEvent = ssrLocal && ssrLocal.kind === "event" ? ssrLocal.event as Record<string, unknown> : null;
    expect(canonicalFields(ssrLocalEvent)).toEqual(canonicalFields(apiLocal));

    const ssrRemote = getSsrInitialData(db, "/@alice@remote.example/remote-parity", null);
    const apiRemoteRes = await app.request("http://localhost/api/v1/events/by-slug/alice@remote.example/remote-parity");
    const apiRemote = await apiRemoteRes.json() as Record<string, unknown>;
    const ssrRemoteEvent = ssrRemote && ssrRemote.kind === "event" ? ssrRemote.event as Record<string, unknown> : null;
    expect(canonicalFields(ssrRemoteEvent)).toEqual(canonicalFields(apiRemote));
  });
});
