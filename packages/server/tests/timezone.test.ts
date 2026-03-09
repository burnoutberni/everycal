import { describe, expect, it } from "vitest";
import { convertLegacyNaiveToUtcIso, isValidIanaTimezone } from "../src/lib/timezone.js";

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
});
