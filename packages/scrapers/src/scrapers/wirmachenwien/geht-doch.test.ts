import { afterEach, describe, expect, it, vi } from "vitest";
import { GehtDochScraper } from "./geht-doch.js";

function mockJsonResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => payload,
  } as const;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GehtDochScraper", () => {
  it("maps Tribe events into normalized EveryCal events with profile metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        events: [
          {
            id: 12,
            title: "<strong>Community Walk Wieden</strong>",
            description: "<p>Jeden letzten Sonntag im Monat.</p>",
            url: "https://geht-doch.info/event/community-walk-wieden/",
            start_date: "2026-04-26 15:00:00",
            end_date: "2026-04-26 17:00:00",
            categories: [{ name: "Community Walk" }],
            venue: {
              venue: "Alois-Drasche-Park",
              city: "Wien",
            },
          },
        ],
      })
    );

    vi.stubGlobal("fetch", fetchMock);

    const scraper = new GehtDochScraper();
    const events = await scraper.scrape();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("wp-json/tribe/events/v1/events");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "geht-doch-12",
      title: "Community Walk Wieden",
      description: "Jeden letzten Sonntag im Monat.",
      startDate: "2026-04-26T15:00:00",
      endDate: "2026-04-26T17:00:00",
      organizer: "GEHT-DOCH",
      visibility: "public",
      location: {
        name: "Alois-Drasche-Park",
        address: "Wien",
      },
    });

    expect(events[0]?.tags).toEqual(
      expect.arrayContaining(["wien", "zu-fuß-gehen", "öffentlicher-raum", "wirmachenwien", "community-walk"])
    );

    expect(scraper.bio).toContain("zivilgesellschaftlich organisierter Verein");
    expect(scraper.avatarUrl).toContain("geht-doch.info");
  });
});
