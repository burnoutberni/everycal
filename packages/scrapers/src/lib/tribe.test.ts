import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTribeEvents } from "./tribe.js";

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

describe("fetchTribeEvents", () => {
  it("follows same-origin pagination URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockJsonResponse({
          events: [{ id: 1, title: "Page one" }],
          next_rest_url: "/wp-json/tribe/events/v1/events?page=2",
        })
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          events: [{ id: 2, title: "Page two" }],
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchTribeEvents("https://flex.at/wp-json/tribe/events/v1/events?page=1");

    expect(events.map((event) => event.id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://flex.at/wp-json/tribe/events/v1/events?page=2");
  });

  it("rejects cross-origin pagination URLs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockJsonResponse({
          events: [{ id: 1, title: "Page one" }],
          next_rest_url: "https://evil.example/collect",
        })
      )
    );

    await expect(fetchTribeEvents("https://flex.at/wp-json/tribe/events/v1/events?page=1")).rejects.toThrow(
      "Unsafe Tribe pagination origin"
    );
  });

  it("detects circular pagination URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockJsonResponse({
          events: [{ id: 1, title: "Page one" }],
          next_rest_url: "https://flex.at/wp-json/tribe/events/v1/events?page=2",
        })
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          events: [{ id: 2, title: "Page two" }],
          next_rest_url: "https://flex.at/wp-json/tribe/events/v1/events?page=1",
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTribeEvents("https://flex.at/wp-json/tribe/events/v1/events?page=1")).rejects.toThrow(
      "Tribe pagination cycle detected"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("limits the number of pagination requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL) => {
      const requestUrl = new URL(String(input));
      const page = Number(requestUrl.searchParams.get("page") || "1");
      return mockJsonResponse({
        events: [{ id: page, title: `Page ${page}` }],
        next_rest_url: `https://flex.at/wp-json/tribe/events/v1/events?page=${page + 1}`,
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTribeEvents("https://flex.at/wp-json/tribe/events/v1/events?page=1")).rejects.toThrow(
      "Tribe pagination exceeded 100 pages"
    );
    expect(fetchMock).toHaveBeenCalledTimes(100);
  });
});
