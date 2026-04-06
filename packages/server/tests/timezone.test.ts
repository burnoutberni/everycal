import { describe, expect, it } from "vitest";
import {
  datePartFromUtcInstantInTimezone,
  deriveEventEndAtUtc,
  deriveEventUtcRange,
  deriveUtcFromTemporalInput,
  extractDatePart,
  isValidIanaTimezone,
  localDateTimeWithTimezoneToUtcIso,
  normalizeApTemporal,
} from "../src/lib/timezone.js";

describe("timezone conversion utilities", () => {
  it("validates IANA timezones", () => {
    expect(isValidIanaTimezone("Europe/Vienna")).toBe(true);
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
  });

  it("converts local datetime in Vienna to UTC", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2024-01-15T10:00", "Europe/Vienna")).toBe("2024-01-15T09:00:00.000Z");
  });

  it("converts local datetime with fractional seconds in Vienna to UTC", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2024-01-15T10:00:00.123", "Europe/Vienna")).toBe("2024-01-15T09:00:00.123Z");
    expect(localDateTimeWithTimezoneToUtcIso("2024-01-15T10:00:00.1", "Europe/Vienna")).toBe("2024-01-15T09:00:00.100Z");
  });

  it("extracts date-only prefix from temporal strings", () => {
    expect(extractDatePart("2026-03-01")).toBe("2026-03-01");
    expect(extractDatePart(" 2026-03-01T10:00:00Z ")).toBe("2026-03-01");
    expect(extractDatePart("2026-02-30")).toBeNull();
    expect(extractDatePart("2026-13-01")).toBeNull();
    expect(extractDatePart(" 2026-02-30T10:00:00Z ")).toBeNull();
    expect(extractDatePart("invalid")).toBeNull();
    expect(extractDatePart(null)).toBeNull();
  });

  it("derives timezone-local date part from UTC instant", () => {
    expect(datePartFromUtcInstantInTimezone("2026-01-01T00:30:00.000Z", "America/Los_Angeles")).toBe("2025-12-31");
    expect(datePartFromUtcInstantInTimezone("2026-01-01T00:30:00.000Z", "UTC")).toBe("2026-01-01");
  });

  it("returns null when deriving timezone-local date part from invalid inputs", () => {
    expect(datePartFromUtcInstantInTimezone("not-an-iso", "UTC")).toBeNull();
    expect(datePartFromUtcInstantInTimezone("2026-01-01T00:30:00.000Z", "Not/AZone")).toBeNull();
  });

  it("treats all-day date-only values as local midnight when timezone is known", () => {
    const normalized = normalizeApTemporal({
      startDate: "2024-01-15",
      endDate: "2024-01-16",
      eventTimezone: "Europe/Vienna",
      allDay: true,
    });

    expect(normalized?.startAtUtc).toBe("2024-01-14T23:00:00.000Z");
    expect(normalized?.allDay).toBe(true);
  });

  it("infers all-day for date-only AP temporal payloads", () => {
    const normalized = normalizeApTemporal({
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      eventTimezone: "Europe/Vienna",
    });

    expect(normalized?.allDay).toBe(true);
    expect(normalized?.startAtUtc).toBe("2026-08-09T22:00:00.000Z");
    expect(normalized?.endAtUtc).toBe("2026-08-11T22:00:00.000Z");
  });

  it("derives all-day end UTC from next day when AP payload omits endDate", () => {
    const normalized = normalizeApTemporal({
      startDate: "2026-08-10",
      eventTimezone: "Europe/Vienna",
    });

    expect(normalized?.allDay).toBe(true);
    expect(normalized?.startAtUtc).toBe("2026-08-09T22:00:00.000Z");
    expect(normalized?.endAtUtc).toBe("2026-08-10T22:00:00.000Z");
  });

  it("derives all-day end UTC as end-exclusive boundary", () => {
    expect(
      deriveEventEndAtUtc("2026-08-11", {
        allDay: true,
        eventTimezone: "Europe/Vienna",
        startValueForAllDay: "2026-08-10",
      }),
    ).toBe("2026-08-11T22:00:00.000Z");
  });

  it("derives all-day UTC range consistently for write paths", () => {
    const range = deriveEventUtcRange("2026-08-10", "2026-08-11", {
      allDay: true,
      eventTimezone: "Europe/Vienna",
    });
    expect(range.startAtUtc).toBe("2026-08-09T22:00:00.000Z");
    expect(range.endAtUtc).toBe("2026-08-11T22:00:00.000Z");
  });

  it("handles DST edge local times deterministically", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2024-03-31T02:30", "Europe/Vienna")).toBe("2024-03-31T01:30:00.000Z");
    expect(localDateTimeWithTimezoneToUtcIso("2024-10-27T02:30", "Europe/Vienna")).toBe("2024-10-27T01:30:00.000Z");
  });

  it("handles fractional milliseconds for DST edge local times", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2024-03-31T02:30:00.500", "Europe/Vienna")).toBe("2024-03-31T01:30:00.500Z");
    expect(localDateTimeWithTimezoneToUtcIso("2024-10-27T02:30:00.500", "Europe/Vienna")).toBe("2024-10-27T01:30:00.500Z");
  });

  it("normalizes AP temporal data with eventTimezone", () => {
    const normalized = normalizeApTemporal({
      startTime: "2026-03-01T09:00:00Z",
      endTime: "2026-03-01T10:00:00Z",
      eventTimezone: "Europe/Vienna",
    });

    expect(normalized.startAtUtc).toBe("2026-03-01T09:00:00.000Z");
    expect(normalized.eventTimezone).toBe("Europe/Vienna");
    expect(normalized.timezoneQuality).toBe("exact_tzid");
  });

  it("normalizes AP temporal data with offset only", () => {
    const normalized = normalizeApTemporal({
      startTime: "2026-03-01T10:00:00+01:00",
      endTime: "2026-03-01T11:00:00+01:00",
    });

    expect(normalized.startAtUtc).toBe("2026-03-01T09:00:00.000Z");
    expect(normalized.eventTimezone).toBeNull();
    expect(normalized.timezoneQuality).toBe("offset_only");
  });

  it("returns null for naive AP datetimes without timezone hint", () => {
    const normalized = normalizeApTemporal({
      startTime: "2026-03-01T10:00:00",
    });

    expect(normalized).toBeNull();
  });

  it("returns null for invalid local datetime strings", () => {
    expect(localDateTimeWithTimezoneToUtcIso("not-a-date", "Europe/Vienna")).toBeNull();
  });

  it("returns null for local datetime values that overflow calendar components", () => {
    expect(localDateTimeWithTimezoneToUtcIso("2026-02-30T10:00:00", "Europe/Vienna")).toBeNull();
    expect(localDateTimeWithTimezoneToUtcIso("2026-13-01T10:00:00", "Europe/Vienna")).toBeNull();
    expect(localDateTimeWithTimezoneToUtcIso("2026-01-15T24:00:00", "Europe/Vienna")).toBeNull();
  });

  it("derives UTC from absolute timestamps with offsets", () => {
    expect(
      deriveUtcFromTemporalInput("2026-03-01T10:00:00+01:00", {
        allDay: false,
        eventTimezone: "Europe/Vienna",
      }),
    ).toBe("2026-03-01T09:00:00.000Z");
  });

  it("trims surrounding whitespace for absolute temporal input", () => {
    expect(
      deriveUtcFromTemporalInput(" 2026-03-01T10:00:00+01:00 ", {
        allDay: false,
        eventTimezone: "Europe/Vienna",
      }),
    ).toBe("2026-03-01T09:00:00.000Z");
  });

  it("returns null for date-only temporal input when all-day is false", () => {
    expect(
      deriveUtcFromTemporalInput("2026-03-01", {
        allDay: false,
        eventTimezone: "Europe/Vienna",
      }),
    ).toBeNull();
  });

  it("returns null for date-only temporal input with invalid calendar date", () => {
    expect(
      deriveUtcFromTemporalInput("2026-02-30", {
        allDay: true,
        eventTimezone: "Europe/Vienna",
      }),
    ).toBeNull();
  });

  it("trims surrounding whitespace for all-day date-only temporal input", () => {
    expect(
      deriveUtcFromTemporalInput(" 2026-03-01 ", {
        allDay: true,
        eventTimezone: "Europe/Vienna",
      }),
    ).toBe("2026-02-28T23:00:00.000Z");
  });

  it("returns null for naive local datetime without timezone", () => {
    expect(
      deriveUtcFromTemporalInput("2026-03-01T10:00:00", {
        allDay: false,
        eventTimezone: null,
      }),
    ).toBeNull();
  });

  it("accepts legacy space-separated local datetimes", () => {
    expect(
      deriveUtcFromTemporalInput("2026-03-01 10:00:00", {
        allDay: false,
        eventTimezone: "Europe/Vienna",
      }),
    ).toBe("2026-03-01T09:00:00.000Z");
  });

  it("returns null for temporal input that is only whitespace", () => {
    expect(
      deriveUtcFromTemporalInput("   ", {
        allDay: false,
        eventTimezone: "Europe/Vienna",
      }),
    ).toBeNull();
  });
});
