import { describe, expect, it } from "vitest";
import type { EveryCalEvent } from "./event.js";
import { toActivityPubEvent } from "./activitypub.js";

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
    expect(() =>
      toActivityPubEvent(
        baseEvent({
          startAtUtc: undefined,
          startDate: "2026-03-01T18:00:00+01:00",
        })
      )
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
});
