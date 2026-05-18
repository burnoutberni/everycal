import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localEventIdFromActivityPubUri } from "../src/lib/activitypub-rsvp.js";

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

  it("returns null for empty or remote-looking fallback strings", () => {
    expect(localEventIdFromActivityPubUri("")).toBeNull();
    expect(localEventIdFromActivityPubUri("   ")).toBeNull();
    expect(localEventIdFromActivityPubUri("https://remote.example/not-a-url-parse-error")).toBeNull();
  });
});
