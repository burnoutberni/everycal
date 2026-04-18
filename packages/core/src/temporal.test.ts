import { describe, expect, it } from "vitest";
import {
  datePartFromUtcInstantInTimezone,
  deriveEventUtcRange,
  isValidIanaTimezone,
  localDateTimeWithTimezoneToUtcIso,
} from "./temporal";

describe("temporal", () => {
  it("validates IANA timezones", () => {
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("Mars/Olympus_Mons")).toBe(false);
  });

  it("converts local date-time in timezone to UTC", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2026-01-15T18:30", "America/New_York")).toBe("2026-01-15T23:30:00.000Z");
  });

  it("rejects invalid local date-time inputs", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2026-02-30T18:30", "America/New_York")).toBeNull();
    expect(localDateTimeWithTimezoneToUtcIso("not-a-datetime", "America/New_York")).toBeNull();
  });

  it("maps nonexistent spring-forward local times deterministically", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2026-03-08T02:30", "America/New_York")).toBe("2026-03-08T06:30:00.000Z");
  });

  it("maps ambiguous fall-back local times to the first occurrence", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2026-11-01T01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("derives UTC range for all-day events using exclusive end", () => {
    expect(
      deriveEventUtcRange("2026-01-15", "2026-01-15", {
        allDay: true,
        eventTimezone: "America/New_York",
      }),
    ).toEqual({
      startAtUtc: "2026-01-15T05:00:00.000Z",
      endAtUtc: "2026-01-16T05:00:00.000Z",
    });
  });

  it("derives spring-forward all-day range with a 23-hour UTC span", () => {
    expect(
      deriveEventUtcRange("2026-03-08", "2026-03-08", {
        allDay: true,
        eventTimezone: "America/New_York",
      }),
    ).toEqual({
      startAtUtc: "2026-03-08T05:00:00.000Z",
      endAtUtc: "2026-03-09T04:00:00.000Z",
    });
  });

  it("derives fall-back all-day range with a 25-hour UTC span", () => {
    expect(
      deriveEventUtcRange("2026-11-01", "2026-11-01", {
        allDay: true,
        eventTimezone: "America/New_York",
      }),
    ).toEqual({
      startAtUtc: "2026-11-01T04:00:00.000Z",
      endAtUtc: "2026-11-02T05:00:00.000Z",
    });
  });

  it("derives date-part in timezone from UTC instant", () => {
    expect(datePartFromUtcInstantInTimezone("2026-01-15T02:00:00.000Z", "America/Los_Angeles")).toBe("2026-01-14");
  });
});
