import { describe, expect, it } from "vitest";
import { buildSyncPayload } from "./build-sync-payload.js";
import type { Scraper } from "../scraper.js";

function makeScraper(defaultEventImageUrl?: string): Scraper {
  return {
    id: "test-source",
    name: "Test Source",
    url: "https://example.com",
    defaultEventImageUrl,
    async scrape() {
      return [];
    },
  };
}

describe("buildSyncPayload", () => {
  it("uses scraper default image when event image is missing", () => {
    const payload = buildSyncPayload(makeScraper("https://example.com/default.jpg"), [
      {
        id: "event-1",
        title: "Sample Event",
        startDate: "2026-03-01T19:00:00.000Z",
      },
    ]);

    expect(payload).toHaveLength(1);
    expect(payload[0].image).toEqual({ url: "https://example.com/default.jpg" });
  });

  it("keeps explicit event image instead of scraper fallback", () => {
    const payload = buildSyncPayload(makeScraper("https://example.com/default.jpg"), [
      {
        id: "event-2",
        title: "Sample Event",
        startDate: "2026-03-01T19:00:00.000Z",
        image: {
          url: "https://example.com/event.jpg",
          alt: "Poster",
        },
      },
    ]);

    expect(payload).toHaveLength(1);
    expect(payload[0].image).toEqual({ url: "https://example.com/event.jpg", alt: "Poster" });
  });
});
