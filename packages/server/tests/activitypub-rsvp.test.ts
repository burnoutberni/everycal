import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase, type DB } from "../src/db.js";
import {
  localEventIdFromActivityPubUri,
  normalizeApPublishedWithFallback,
  resolveLocalRsvpEventTarget,
  shouldApplyRemoteRsvpUpdate,
} from "../src/lib/activitypub-rsvp.js";

describe("localEventIdFromActivityPubUri", () => {
  let previousBaseUrl: string | undefined;

  beforeEach(() => {
    previousBaseUrl = process.env.BASE_URL;
    process.env.BASE_URL = "http://localhost";
  });

  afterEach(() => {
    if (previousBaseUrl === undefined) {
      delete process.env.BASE_URL;
      return;
    }
    process.env.BASE_URL = previousBaseUrl;
  });

  it("returns local event id for matching BASE_URL event URIs", () => {
    expect(localEventIdFromActivityPubUri("http://localhost/events/event-1")).toBe("event-1");
    expect(localEventIdFromActivityPubUri(" http://localhost/events/event-1/ ")).toBe("event-1");
  });

  it("supports local event URIs when BASE_URL includes a path prefix", () => {
    process.env.BASE_URL = "https://example.com/root";

    expect(localEventIdFromActivityPubUri("https://example.com/root/events/event-1")).toBe("event-1");
    expect(localEventIdFromActivityPubUri("https://example.com/root/events/event-1/")).toBe("event-1");
    expect(localEventIdFromActivityPubUri("https://example.com/events/event-1")).toBeNull();
  });

  it("decodes encoded event ids from local event URIs", () => {
    expect(localEventIdFromActivityPubUri("http://localhost/events/hello%20world")).toBe("hello world");
  });

  it("returns null for malformed percent-encoding in local event URIs", () => {
    expect(localEventIdFromActivityPubUri("http://localhost/events/%E0%A4")).toBeNull();
    expect(localEventIdFromActivityPubUri("http://localhost/events/%")).toBeNull();
  });

  it("returns null for non-local or non-event HTTP(S) URIs", () => {
    expect(localEventIdFromActivityPubUri("https://remote.example/events/event-1")).toBeNull();
    expect(localEventIdFromActivityPubUri("http://localhost/not-events/event-1")).toBeNull();
  });

  it("keeps raw non-URL local ids as fallback", () => {
    expect(localEventIdFromActivityPubUri("event-1")).toBe("event-1");
    expect(localEventIdFromActivityPubUri("  event-1  ")).toBe("event-1");
  });

  it("returns null for empty, remote-looking, or scheme-looking fallback strings", () => {
    expect(localEventIdFromActivityPubUri("")).toBeNull();
    expect(localEventIdFromActivityPubUri("   ")).toBeNull();
    expect(localEventIdFromActivityPubUri("https://remote.example/not-a-url-parse-error")).toBeNull();
    expect(localEventIdFromActivityPubUri("foo://[::1")).toBeNull();
  });
});

describe("shouldApplyRemoteRsvpUpdate", () => {
  it("does not apply when timestamp and precedence are unchanged", () => {
    expect(
      shouldApplyRemoteRsvpUpdate(
        { last_activity_published_at: "2025-01-01T10:00:00.000Z", last_activity_precedence: 30 },
        { publishedAt: "2025-01-01T10:00:00.000Z", precedence: 30 },
      ),
    ).toBe(false);
  });

  it("does not apply when both timestamps are missing and precedence is unchanged", () => {
    expect(
      shouldApplyRemoteRsvpUpdate(
        { last_activity_published_at: null, last_activity_precedence: 20 },
        { publishedAt: null, precedence: 20 },
      ),
    ).toBe(false);
  });

  it("applies when precedence increases with equal timestamp", () => {
    expect(
      shouldApplyRemoteRsvpUpdate(
        { last_activity_published_at: "2025-01-01T10:00:00.000Z", last_activity_precedence: 20 },
        { publishedAt: "2025-01-01T10:00:00.000Z", precedence: 30 },
      ),
    ).toBe(true);
  });

  it("applies when existing timestamp is present, incoming timestamp is missing, and precedence increases", () => {
    expect(
      shouldApplyRemoteRsvpUpdate(
        { last_activity_published_at: "2025-01-01T10:00:00.000Z", last_activity_precedence: 20 },
        { publishedAt: null, precedence: 50 },
      ),
    ).toBe(true);
  });

  it("does not apply when existing timestamp is present, incoming timestamp is missing, and precedence is unchanged", () => {
    expect(
      shouldApplyRemoteRsvpUpdate(
        { last_activity_published_at: "2025-01-01T10:00:00.000Z", last_activity_precedence: 50 },
        { publishedAt: null, precedence: 50 },
      ),
    ).toBe(false);
  });
});

describe("normalizeApPublishedWithFallback", () => {
  it("returns normalized published when published is valid", () => {
    expect(normalizeApPublishedWithFallback("2026-05-03T10:00:00Z", "2026-05-02T10:00:00Z"))
      .toBe("2026-05-03T10:00:00.000Z");
  });

  it("falls back to updated when published is invalid", () => {
    expect(normalizeApPublishedWithFallback("not-a-date", "2026-05-02T10:00:00Z"))
      .toBe("2026-05-02T10:00:00.000Z");
  });

  it("falls back to updated when published is blank", () => {
    expect(normalizeApPublishedWithFallback("", "2026-05-02T10:00:00Z"))
      .toBe("2026-05-02T10:00:00.000Z");
    expect(normalizeApPublishedWithFallback("   ", "2026-05-02T10:00:00Z"))
      .toBe("2026-05-02T10:00:00.000Z");
  });

  it("returns null when published and updated are both invalid", () => {
    expect(normalizeApPublishedWithFallback("nope", "still-nope")).toBeNull();
  });
});

describe("resolveLocalRsvpEventTarget", () => {
  let db: DB;
  let previousBaseUrl: string | undefined;

  beforeEach(() => {
    previousBaseUrl = process.env.BASE_URL;
    process.env.BASE_URL = "http://localhost";
    db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username, account_type) VALUES (?, ?, 'person')").run("a1", "alice");
    db.prepare(
      "INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("event-1", "a1", "Event", "2026-06-01T10:00:00", "2026-06-01T10:00:00.000Z", "UTC", "public");
  });

  afterEach(() => {
    if (previousBaseUrl === undefined) {
      delete process.env.BASE_URL;
      return;
    }
    process.env.BASE_URL = previousBaseUrl;
  });

  it("rejects RSVP targets that reference the event as a string", () => {
    const target = resolveLocalRsvpEventTarget(db, {
      type: "Accept",
      actor: "https://remote.example/users/bob",
      object: "http://localhost/events/event-1",
    });
    expect(target).toBeNull();
  });

  it("rejects RSVP targets without attributedTo/actor owner metadata", () => {
    const target = resolveLocalRsvpEventTarget(db, {
      type: "Accept",
      actor: "https://remote.example/users/bob",
      object: { type: "Event", id: "http://localhost/events/event-1" },
    });
    expect(target).toBeNull();
  });

  it("accepts RSVP targets when Event.attributedTo matches local owner", () => {
    const target = resolveLocalRsvpEventTarget(db, {
      type: "Accept",
      actor: "https://remote.example/users/bob",
      object: {
        type: "Event",
        id: "http://localhost/events/event-1",
        attributedTo: "http://localhost/users/alice",
      },
    });
    expect(target).toEqual({ eventId: "event-1", ownerActorUri: "http://localhost/users/alice" });
  });
});
