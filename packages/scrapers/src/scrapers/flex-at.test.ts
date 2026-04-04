import { afterEach, describe, expect, it, vi } from "vitest";
import { FlexScraper } from "./flex-at.js";

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

describe("FlexScraper", () => {
  it("maps Flex API events into normalized EveryCal events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          events: [
            {
              id: 42,
              title: "Live at Flex",
              description: "An all-night set",
              url: "https://flex.at/event/live-at-flex",
              utc_start_date: "2026-06-10 20:00:00",
              utc_end_date: "2026-06-10 23:00:00",
              all_day: false,
              categories: [{ name: "Techno" }, { name: "Nightlife" }],
              image: { url: "https://cdn.flex.at/event.jpg" },
            },
          ],
        })
      )
    );

    const scraper = new FlexScraper();
    const events = await scraper.scrape();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "flex-at-42",
      title: "Live at Flex",
      description: "An all-night set",
      startDate: "2026-06-10T20:00:00Z",
      endDate: "2026-06-10T23:00:00Z",
      allDay: false,
      visibility: "public",
      url: "https://flex.at/event/live-at-flex",
      image: {
        url: "https://cdn.flex.at/event.jpg",
        mediaType: "image/jpeg",
      },
      location: {
        name: "Flex",
        address: "Donaukanal / Augartenbrucke, 1010 Wien",
      },
    });

    expect(events[0]?.tags).toEqual(
      expect.arrayContaining(["techno", "nightlife", "wien", "music"])
    );
  });

  it("follows pagination and skips invalid events", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockJsonResponse({
          events: [
            {
              id: 1,
              title: "First event",
              utc_start_date: "2026-07-01 18:00:00",
            },
            {
              id: 2,
              title: "",
              utc_start_date: "2026-07-01 19:00:00",
            },
          ],
          next_rest_url: "https://flex.at/wp-json/tribe/events/v1/events?page=2",
        })
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          events: [
            {
              id: 3,
              title: "Second page event",
              start_date: "2026-07-02 20:00:00",
            },
            {
              id: 4,
              title: "Missing date",
            },
          ],
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const scraper = new FlexScraper();
    const events = await scraper.scrape();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("status=publish");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://flex.at/wp-json/tribe/events/v1/events?page=2"
    );

    expect(events.map((e) => e.id)).toEqual(["flex-at-1", "flex-at-3"]);
    expect(events[0]?.startDate).toBe("2026-07-01T18:00:00Z");
    expect(events[1]?.startDate).toBe("2026-07-02T20:00:00");
  });
});
