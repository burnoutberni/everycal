import { describe, expect, expectTypeOf, it } from "vitest";
import { formatEventDateTime } from "./formatEventDateTime";

describe("formatEventDateTime", () => {
  it("returns null for timed events without startAtUtc", () => {
    const result = formatEventDateTime({
      startDate: "2026-08-20T10:00:00",
      endDate: null,
      startAtUtc: "",
      endAtUtc: null,
      allDay: false,
      eventTimezone: "UTC",
    });

    expect(result).toBeNull();
  });

  it("returns a formatted label for valid timed events", () => {
    const result = formatEventDateTime(
      {
        startDate: "2026-08-20T10:00:00",
        endDate: null,
        startAtUtc: "2026-08-20T10:00:00.000Z",
        endAtUtc: null,
        allDay: false,
        eventTimezone: "UTC",
      },
      true,
      {
        locale: "en-US",
        allDayLabel: "All day",
        displayTimeZone: "UTC",
      },
    );

    expect(result).toContain("2026");
    expect(result).toContain("10:00");
  });

  it("exposes nullable return type to callers", () => {
    const result = formatEventDateTime({
      startDate: "2026-08-20T10:00:00",
      endDate: null,
      startAtUtc: "2026-08-20T10:00:00.000Z",
      endAtUtc: null,
      allDay: false,
      eventTimezone: "UTC",
    });

    expectTypeOf(result).toEqualTypeOf<string | null>();
  });
});
