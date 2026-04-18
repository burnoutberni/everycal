import { describe, expect, it } from "vitest";
import { fromICal, localInZoneToUtcIso, toICal, toICalendar } from "./ical.js";
import type { EveryCalEvent } from "./event.js";

function baseEvent(overrides: Partial<EveryCalEvent> = {}): EveryCalEvent {
  return {
    id: "event-1",
    title: "Test Event",
    startDate: "2026-03-01T10:00:00",
    endDate: "2026-03-01T11:00:00",
    startAtUtc: "2026-03-01T09:00:00.000Z",
    visibility: "public",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("ical timezone export/import", () => {
  it("exports timed TZID events with VTIMEZONE", () => {
    const event = baseEvent({
      eventTimezone: "Europe/Vienna",
      startAtUtc: "2026-03-01T09:00:00.000Z",
      endAtUtc: "2026-03-01T10:00:00.000Z",
    });
    const ical = toICalendar([{ event }], { calendarName: "Timezone Feed" });

    expect(ical).toContain("BEGIN:VTIMEZONE");
    expect(ical).toContain("TZID:Europe/Vienna");
    expect(ical).toContain("DTSTART;TZID=Europe/Vienna:20260301T100000");
    expect(ical).toContain("DTEND;TZID=Europe/Vienna:20260301T110000");
  });

  it("derives timed TZID export when UTC fields are missing", () => {
    const event = baseEvent({
      eventTimezone: "Europe/Vienna",
      startAtUtc: undefined,
      endAtUtc: undefined,
    });

    const vevent = toICal(event);
    expect(vevent).toContain("DTSTART;TZID=Europe/Vienna:20260301T100000");
    expect(vevent).toContain("DTEND;TZID=Europe/Vienna:20260301T110000");
  });

  it("derives timed TZID export when local source includes fractional seconds", () => {
    const event = baseEvent({
      eventTimezone: "Europe/Vienna",
      startDate: "2026-03-01T10:00:00.123",
      endDate: "2026-03-01T11:00:00.123",
      startAtUtc: undefined,
      endAtUtc: undefined,
    });

    const vevent = toICal(event);
    expect(vevent).toContain("DTSTART;TZID=Europe/Vienna:20260301T100000");
    expect(vevent).toContain("DTEND;TZID=Europe/Vienna:20260301T110000");
  });

  it("converts local TZID datetimes with fractional seconds to precise UTC", () => {
    expect(localInZoneToUtcIso("2024-01-15T10:00:00.123", "Europe/Vienna")).toBe("2024-01-15T09:00:00.123Z");
    expect(localInZoneToUtcIso("2024-01-15T10:00:00.1", "Europe/Vienna")).toBe("2024-01-15T09:00:00.100Z");
  });

  it("keeps fractional-second precision on DST-edge local times", () => {
    expect(localInZoneToUtcIso("2024-03-31T02:30:00.500", "Europe/Vienna")).toBe("2024-03-31T01:30:00.500Z");
    expect(localInZoneToUtcIso("2024-10-27T02:30:00.500", "Europe/Vienna")).toBe("2024-10-27T01:30:00.500Z");
  });

  it("returns null for invalid timezone or invalid local datetime", () => {
    expect(localInZoneToUtcIso("2024-01-15T10:00:00", "Mars/Olympus_Mons")).toBeNull();
    expect(localInZoneToUtcIso("not-a-datetime", "Europe/Vienna")).toBeNull();
  });

  it("exports UTC fallback when timezone is unknown", () => {
    const event = baseEvent({
      startAtUtc: "2026-03-01T09:00:00.000Z",
      endAtUtc: "2026-03-01T10:00:00.000Z",
      eventTimezone: undefined,
    });

    const vevent = toICal(event);
    expect(vevent).toContain("DTSTART:20260301T090000Z");
    expect(vevent).toContain("DTEND:20260301T100000Z");
  });

  it("throws when timed UTC export is missing startAtUtc", () => {
    const event = {
      ...baseEvent({
        endAtUtc: "2026-03-01T10:00:00.000Z",
        eventTimezone: undefined,
      }),
      startAtUtc: undefined,
    } as unknown as EveryCalEvent;

    expect(() => toICal(event)).toThrow(/startAtUtc/);
  });

  it("throws when endDate exists but endAtUtc is missing", () => {
    const event = baseEvent({
      startAtUtc: "2026-03-01T09:00:00.000Z",
      endAtUtc: undefined,
      eventTimezone: undefined,
    });

    expect(() => toICal(event)).toThrow(/endAtUtc/);
  });

  it("derives endAtUtc from offset endDate when missing", () => {
    const event = baseEvent({
      startDate: "2026-03-01T10:00:00+01:00",
      endDate: "2026-03-01T11:00:00+01:00",
      startAtUtc: "2026-03-01T09:00:00.000Z",
      endAtUtc: undefined,
      eventTimezone: undefined,
    });

    const vevent = toICal(event);
    expect(vevent).toContain("DTEND:20260301T100000Z");
  });

  it("exports all-day events with DATE values and end-exclusive DTEND", () => {
    const event = baseEvent({
      startDate: "2026-05-10",
      endDate: "2026-05-10",
      allDay: true,
    });
    const vevent = toICal(event);

    expect(vevent).toContain("DTSTART;VALUE=DATE:20260510");
    expect(vevent).toContain("DTEND;VALUE=DATE:20260511");
  });

  it("imports TZID events into tzid + UTC", () => {
    const parsed = fromICal([
      "BEGIN:VEVENT",
      "UID:tzid-1",
      "SUMMARY:TZID Test",
      "DTSTART;TZID=Europe/Vienna:20260301T100000",
      "DTEND;TZID=Europe/Vienna:20260301T110000",
      "END:VEVENT",
    ].join("\r\n"));

    expect(parsed.eventTimezone).toBe("Europe/Vienna");
    expect(parsed.timezoneQuality).toBe("exact_tzid");
    expect(parsed.startDate).toBe("2026-03-01T10:00:00");
    expect(parsed.startAtUtc).toBe("2026-03-01T09:00:00.000Z");
  });

  it("imports UTC timestamp events", () => {
    const parsed = fromICal([
      "BEGIN:VEVENT",
      "UID:utc-1",
      "DTSTART:20260301T090000Z",
      "DTEND:20260301T100000Z",
      "END:VEVENT",
    ].join("\r\n"));

    expect(parsed.startDate).toBe("2026-03-01T09:00:00Z");
    expect(parsed.startAtUtc).toBe("2026-03-01T09:00:00.000Z");
    expect(parsed.timezoneQuality).toBe("offset_only");
  });

  it("imports all-day events with end-exclusive normalization", () => {
    const parsed = fromICal([
      "BEGIN:VEVENT",
      "UID:all-day-1",
      "DTSTART;VALUE=DATE:20260510",
      "DTEND;VALUE=DATE:20260511",
      "END:VEVENT",
    ].join("\r\n"));

    expect(parsed.allDay).toBe(true);
    expect(parsed.startDate).toBe("2026-05-10");
    expect(parsed.endDate).toBe("2026-05-10");
  });

  it("keeps folded lines and parameterized keys parseable", () => {
    const parsed = fromICal([
      "BEGIN:VEVENT",
      "UID:folded-1",
      "SUMMARY:Folded title",
      "DESCRIPTION:Line one",
      " line two",
      "X-IMAGE;VALUE=URI:https://example.com/image.jpg",
      "DTSTART;TZID=Europe/Vienna:20260301T100000",
      "END:VEVENT",
    ].join("\r\n"));

    expect(parsed.description).toContain("Line oneline two");
    expect(parsed.image?.url).toBe("https://example.com/image.jpg");
    expect(parsed.eventTimezone).toBe("Europe/Vienna");
  });
});
