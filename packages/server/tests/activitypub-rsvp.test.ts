import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localEventIdFromActivityPubUri, shouldApplyRemoteRsvpUpdate } from "../src/lib/activitypub-rsvp.js";

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
});
