import { describe, expect, it } from "vitest";
import { convertLegacyNaiveToUtcIso, isValidIanaTimezone, normalizeApTemporal } from "../src/lib/timezone.js";

describe("timezone conversion utilities", () => {
  it("validates IANA timezones", () => {
    expect(isValidIanaTimezone("Europe/Vienna")).toBe(true);
    expect(isValidIanaTimezone("Not/AZone")).toBe(false);
  });

  it("converts local datetime in Vienna to UTC", () => {
    expect(convertLegacyNaiveToUtcIso("2024-01-15T10:00", "Europe/Vienna")).toBe("2024-01-15T09:00:00.000Z");
  });

  it("treats date-only values as local midnight in fallback timezone", () => {
    expect(convertLegacyNaiveToUtcIso("2024-01-15", "Europe/Vienna")).toBe("2024-01-14T23:00:00.000Z");
  });

  it("handles DST edge local times deterministically", () => {
    expect(convertLegacyNaiveToUtcIso("2024-03-31T02:30", "Europe/Vienna")).toBe("2024-03-31T01:30:00.000Z");
    expect(convertLegacyNaiveToUtcIso("2024-10-27T02:30", "Europe/Vienna")).toBe("2024-10-27T01:30:00.000Z");
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

  it("keeps naive AP datetimes unknown without timezone hint", () => {
    const normalized = normalizeApTemporal({
      startTime: "2026-03-01T10:00:00",
    });

    expect(normalized.startAtUtc).toBeNull();
    expect(normalized.timezoneQuality).toBe("unknown");
  });
});
