import { describe, expect, it } from "vitest";
import { rowToEvent } from "../src/lib/feed-event.js";

describe("rowToEvent", () => {
  const baseRow = {
    id: "e1",
    title: "Event",
    start_date: "2026-03-15",
    start_at_utc: "2026-03-15T00:00:00.000Z",
    event_timezone: "UTC",
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-02T00:00:00.000Z",
  };

  it("preserves valid non-public visibility", () => {
    const event = rowToEvent({ ...baseRow, visibility: "followers_only" });
    expect(event.visibility).toBe("followers_only");
  });

  it("falls back to public for invalid visibility values", () => {
    const event = rowToEvent({ ...baseRow, visibility: "friends_only" });
    expect(event.visibility).toBe("public");
  });

  it("normalizes nullable optional DB fields to undefined", () => {
    const event = rowToEvent({
      ...baseRow,
      description: null,
      end_date: null,
      end_at_utc: null,
      url: null,
      location_name: "Venue",
      location_address: null,
      location_latitude: null,
      location_longitude: null,
      location_url: null,
      image_url: "https://example.com/image.jpg",
      image_media_type: null,
      image_alt: null,
    });

    expect(event.description).toBeUndefined();
    expect(event.endDate).toBeUndefined();
    expect(event.endAtUtc).toBeUndefined();
    expect(event.url).toBeUndefined();
    expect(event.location?.address).toBeUndefined();
    expect(event.location?.latitude).toBeUndefined();
    expect(event.location?.longitude).toBeUndefined();
    expect(event.location?.url).toBeUndefined();
    expect(event.image?.mediaType).toBeUndefined();
    expect(event.image?.alt).toBeUndefined();
  });
});
