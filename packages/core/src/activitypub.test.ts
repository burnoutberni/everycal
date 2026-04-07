import { describe, expect, it } from "vitest";
import type { EveryCalEvent } from "./event.js";
import { fromActivityPubEvent, toActivityPubEvent } from "./activitypub.js";

function baseEvent(overrides: Partial<EveryCalEvent> = {}): EveryCalEvent {
  return {
    id: "https://events.everycal.test/e/1",
    title: "Board Game Night",
    startDate: "2026-03-01T18:00:00+01:00",
    startAtUtc: "2026-03-01T17:00:00.000Z",
    visibility: "public",
    createdAt: "2026-02-01T10:00:00.000Z",
    updatedAt: "2026-02-02T11:00:00.000Z",
    ...overrides,
  };
}

describe("toActivityPubEvent", () => {
  it("emits UTC timestamps from canonical UTC fields", () => {
    const ap = toActivityPubEvent(
      baseEvent({
        endDate: "2026-03-01T20:00:00+01:00",
        endAtUtc: "2026-03-01T19:00:00.000Z",
      })
    );

    expect(ap.startTime).toBe("2026-03-01T17:00:00.000Z");
    expect(ap.endTime).toBe("2026-03-01T19:00:00.000Z");
  });

  it("throws when startAtUtc is missing instead of falling back to startDate", () => {
    const invalidEvent = {
      ...baseEvent({
        startDate: "2026-03-01T18:00:00+01:00",
      }),
      startAtUtc: undefined,
    } as unknown as EveryCalEvent;

    expect(() =>
      toActivityPubEvent(invalidEvent)
    ).toThrow(/startAtUtc/);
  });

  it("throws when endDate exists but endAtUtc is missing", () => {
    expect(() =>
      toActivityPubEvent(
        baseEvent({
          endDate: "2026-03-01T20:00:00+01:00",
          endAtUtc: undefined,
        })
      )
    ).toThrow(/endAtUtc/);
  });

  it("emits date-only values for all-day events", () => {
    const ap = toActivityPubEvent(
      baseEvent({
        allDay: true,
        startDate: "2026-03-01",
        endDate: "2026-03-02",
        startAtUtc: undefined,
        endAtUtc: undefined,
      } as unknown as EveryCalEvent)
    );

    expect(ap.startTime).toBe("2026-03-01");
    expect(ap.endTime).toBe("2026-03-02");
  });
});

describe("fromActivityPubEvent", () => {
  it("marks date-only AP events as all-day", () => {
    const ev = fromActivityPubEvent({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/events/day-1",
      type: "Event",
      name: "All Day",
      startTime: "2026-03-01",
      endTime: "2026-03-02",
      to: [],
      cc: [],
      published: "2026-02-01T10:00:00.000Z",
      updated: "2026-02-01T10:00:00.000Z",
    });

    expect(ev.allDay).toBe(true);
    expect(ev.startDate).toBe("2026-03-01");
    expect(ev.endDate).toBe("2026-03-02");
    expect(ev.startAtUtc).toBeUndefined();
    expect(ev.endAtUtc).toBeUndefined();
  });
});
