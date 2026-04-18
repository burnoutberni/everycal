import { describe, expect, it } from "vitest";
import {
  computeMaterialEventChanges,
  deriveCanonicalTemporalFields,
  deriveStoredDatePart,
  deriveUpdateTemporalFields,
  normalizeEventWriteInput,
  sanitizeEventWriteFields,
} from "../src/lib/event-write.js";

describe("event write normalization", () => {
  it("normalizes timed input using datetime fields when allowed", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      startDateTime: "2026-01-10T10:30",
      endDate: "2026-01-10",
      endDateTime: "2026-01-10T11:30",
      eventTimezone: "Europe/Vienna",
      allDay: false,
      allowDateTimeFields: true,
    });

    expect(normalized).toEqual({
      startValue: "2026-01-10T10:30",
      endValue: "2026-01-10T11:30",
      eventTimezone: "Europe/Vienna",
      allDay: false,
    });
  });

  it("ignores datetime fields when allowDateTimeFields is false", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      startDateTime: "2026-01-10T10:30",
      endDate: "2026-01-11",
      endDateTime: "2026-01-10T11:30",
      eventTimezone: "Europe/Vienna",
      allDay: false,
      allowDateTimeFields: false,
    });

    expect(normalized).toEqual({
      startValue: "2026-01-10",
      endValue: "2026-01-11",
      eventTimezone: "Europe/Vienna",
      allDay: false,
    });
  });

  it("rejects all-day payloads with datetime values", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      startDateTime: "2026-01-10T10:30",
      eventTimezone: "Europe/Vienna",
      allDay: true,
      allowDateTimeFields: true,
    });

    expect(normalized).toBeNull();
  });

  it("rejects all-day payloads with invalid date-only values", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10T10:30",
      eventTimezone: "Europe/Vienna",
      allDay: true,
      allowDateTimeFields: false,
    });

    expect(normalized).toBeNull();
  });

  it("returns null when required start or timezone are missing", () => {
    expect(
      normalizeEventWriteInput({
        eventTimezone: "Europe/Vienna",
        allowDateTimeFields: false,
      }),
    ).toBeNull();
    expect(
      normalizeEventWriteInput({
        startDate: "2026-01-10",
        allowDateTimeFields: false,
      }),
    ).toBeNull();
  });

  it("trims whitespace and normalizes empty end values to null", () => {
    const normalized = normalizeEventWriteInput({
      startDate: " 2026-01-10 ",
      endDate: "   ",
      eventTimezone: "Europe/Vienna",
      allDay: true,
      allowDateTimeFields: false,
    });

    expect(normalized).toEqual({
      startValue: "2026-01-10",
      endValue: null,
      eventTimezone: "Europe/Vienna",
      allDay: true,
    });
  });

  it("treats null endDateTime as omitted and falls back to endDate", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      startDateTime: "2026-01-10T10:30",
      endDate: "2026-01-11",
      endDateTime: null,
      eventTimezone: "Europe/Vienna",
      allDay: false,
      allowDateTimeFields: true,
    });

    expect(normalized).toEqual({
      startValue: "2026-01-10T10:30",
      endValue: "2026-01-11",
      eventTimezone: "Europe/Vienna",
      allDay: false,
    });
  });

  it("accepts all-day payloads when endDateTime is explicitly null", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      endDate: "2026-01-11",
      endDateTime: null,
      eventTimezone: "Europe/Vienna",
      allDay: true,
      allowDateTimeFields: true,
    });

    expect(normalized).toEqual({
      startValue: "2026-01-10",
      endValue: "2026-01-11",
      eventTimezone: "Europe/Vienna",
      allDay: true,
    });
  });

  it("treats null startDateTime as omitted and falls back to startDate", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      startDateTime: null,
      eventTimezone: "Europe/Vienna",
      allDay: false,
      allowDateTimeFields: true,
    });

    expect(normalized).toEqual({
      startValue: "2026-01-10",
      endValue: null,
      eventTimezone: "Europe/Vienna",
      allDay: false,
    });
  });

  it("returns null when startDateTime is present but not a string", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      startDateTime: 123 as unknown as string,
      eventTimezone: "Europe/Vienna",
      allowDateTimeFields: true,
    });

    expect(normalized).toBeNull();
  });

  it("returns null when endDateTime is present but not a string", () => {
    const normalized = normalizeEventWriteInput({
      startDate: "2026-01-10",
      endDate: "2026-01-11",
      endDateTime: { bad: true } as unknown as string,
      eventTimezone: "Europe/Vienna",
      allowDateTimeFields: true,
    });

    expect(normalized).toBeNull();
  });
});

describe("event write sanitization", () => {
  it("drops non-array tag payloads", () => {
    const body: Record<string, unknown> = { tags: "oops" };

    sanitizeEventWriteFields(body);

    expect(body.tags).toBeUndefined();
  });

  it("keeps only string tags and sanitizes HTML", () => {
    const body: Record<string, unknown> = {
      tags: ["  <b>music</b>  ", 123, "", null, "<i>art</i>", {}, "   "],
    };

    sanitizeEventWriteFields(body);

    expect(body.tags).toEqual(["music", "art"]);
  });

  it("preserves explicit empty tag arrays", () => {
    const body: Record<string, unknown> = { tags: [] };

    sanitizeEventWriteFields(body);

    expect(body.tags).toEqual([]);
  });
});

describe("event write canonical derivation", () => {
  it("keeps date parts directly for all-day values", () => {
    const startOn = deriveStoredDatePart("2026-08-10", "2026-08-09T22:00:00.000Z", {
      allDay: true,
      eventTimezone: "Europe/Vienna",
    });

    expect(startOn).toBe("2026-08-10");
  });

  it("derives local date part from UTC instant for timed values", () => {
    const startOn = deriveStoredDatePart("2026-01-01T00:30:00.000Z", "2026-01-01T00:30:00.000Z", {
      allDay: false,
      eventTimezone: "America/Los_Angeles",
    });

    expect(startOn).toBe("2025-12-31");
  });

  it("falls back to raw date prefix when UTC conversion is unavailable", () => {
    const startOn = deriveStoredDatePart("2026-01-01T10:00:00", null, {
      allDay: false,
      eventTimezone: "Europe/Vienna",
    });

    expect(startOn).toBe("2026-01-01");
  });

  it("derives canonical fields for all-day events with omitted end", () => {
    const canonical = deriveCanonicalTemporalFields({
      startValue: "2026-08-10",
      endValue: null,
      eventTimezone: "Europe/Vienna",
      allDay: true,
    });

    expect(canonical).toEqual({
      startAtUtc: "2026-08-09T22:00:00.000Z",
      endAtUtc: "2026-08-10T22:00:00.000Z",
      startOn: "2026-08-10",
      endOn: null,
    });
  });
});

describe("event write update temporal derivation", () => {
  it("recomputes UTC values when timezone changes", () => {
    const result = deriveUpdateTemporalFields({
      nextAllDay: false,
      existingStart: "2026-04-10T10:00",
      existingEnd: "2026-04-10T11:00",
      existingTimezone: "Europe/Vienna",
      nextTimezone: "UTC",
      shouldRecomputeUtcForTimezoneChange: true,
      shouldRecomputeAllDayEndBoundary: false,
    });

    expect(result.tzForConvert).toBe("UTC");
    expect(result.startForUtc).toBe("2026-04-10T10:00");
    expect(result.endForUtc).toBe("2026-04-10T11:00");
    expect(result.nextStartAtUtc).toBe("2026-04-10T10:00:00.000Z");
    expect(result.nextEndAtUtc).toBe("2026-04-10T11:00:00.000Z");
  });

  it("recomputes all-day end boundary when requested", () => {
    const result = deriveUpdateTemporalFields({
      nextAllDay: true,
      existingStart: "2026-08-10",
      existingEnd: null,
      existingTimezone: "Europe/Vienna",
      shouldRecomputeUtcForTimezoneChange: false,
      shouldRecomputeAllDayEndBoundary: true,
    });

    expect(result.startForUtc).toBeUndefined();
    expect(result.endForUtc).toBeNull();
    expect(result.nextStartAtUtc).toBeNull();
    expect(result.nextEndAtUtc).toBe("2026-08-10T22:00:00.000Z");
  });

  it("does not recompute untouched UTC values", () => {
    const result = deriveUpdateTemporalFields({
      nextAllDay: false,
      existingStart: "2026-04-10T10:00",
      existingEnd: "2026-04-10T11:00",
      existingTimezone: "Europe/Vienna",
      shouldRecomputeUtcForTimezoneChange: false,
      shouldRecomputeAllDayEndBoundary: false,
    });

    expect(result.startForUtc).toBeUndefined();
    expect(result.endForUtc).toBeUndefined();
    expect(result.nextStartAtUtc).toBeNull();
    expect(result.nextEndAtUtc).toBeNull();
  });

  it("treats explicit nextEnd null differently from undefined", () => {
    const explicitNull = deriveUpdateTemporalFields({
      nextAllDay: false,
      existingStart: "2026-04-10T10:00",
      existingEnd: "2026-04-10T11:00",
      existingTimezone: "Europe/Vienna",
      nextEnd: null,
      shouldRecomputeUtcForTimezoneChange: false,
      shouldRecomputeAllDayEndBoundary: false,
    });
    const implicitUndefined = deriveUpdateTemporalFields({
      nextAllDay: false,
      existingStart: "2026-04-10T10:00",
      existingEnd: "2026-04-10T11:00",
      existingTimezone: "Europe/Vienna",
      shouldRecomputeUtcForTimezoneChange: false,
      shouldRecomputeAllDayEndBoundary: false,
    });

    expect(explicitNull.endForUtc).toBeNull();
    expect(implicitUndefined.endForUtc).toBeUndefined();
  });
});

describe("material event change detection", () => {
  it("returns empty list when snapshots are materially equivalent", () => {
    const changes = computeMaterialEventChanges(
      {
        title: "Town Hall",
        startDate: "2026-04-10",
        endDate: null,
        allDay: true,
        eventTimezone: "Europe/Vienna",
        startAtUtc: "2026-04-09T22:00:00.000Z",
        endAtUtc: "2026-04-10T22:00:00.000Z",
        locationName: undefined,
        locationAddress: null,
      },
      {
        title: "Town Hall",
        startDate: "2026-04-10",
        endDate: undefined,
        allDay: true,
        eventTimezone: "Europe/Vienna",
        startAtUtc: "2026-04-09T22:00:00.000Z",
        endAtUtc: "2026-04-10T22:00:00.000Z",
        locationName: null,
        locationAddress: undefined,
      },
    );

    expect(changes).toEqual([]);
  });

  it("detects title, time and location changes independently", () => {
    const changes = computeMaterialEventChanges(
      {
        title: "Town Hall",
        startDate: "2026-04-10",
        endDate: "2026-04-11",
        allDay: true,
        eventTimezone: "Europe/Vienna",
        startAtUtc: "2026-04-09T22:00:00.000Z",
        endAtUtc: "2026-04-11T22:00:00.000Z",
        locationName: "Room A",
        locationAddress: "Main Street 1",
      },
      {
        title: "City Forum",
        startDate: "2026-04-10",
        endDate: "2026-04-12",
        allDay: true,
        eventTimezone: "Europe/Vienna",
        startAtUtc: "2026-04-09T22:00:00.000Z",
        endAtUtc: "2026-04-12T22:00:00.000Z",
        locationName: "Room B",
        locationAddress: "Main Street 2",
      },
    );

    expect(changes.map((change) => change.field)).toEqual(["title", "time", "location"]);
  });

  it("marks time change when timezone differs even with same date strings", () => {
    const changes = computeMaterialEventChanges(
      {
        title: "Town Hall",
        startDate: "2026-04-10",
        endDate: "2026-04-11",
        allDay: true,
        eventTimezone: "Europe/Vienna",
      },
      {
        title: "Town Hall",
        startDate: "2026-04-10",
        endDate: "2026-04-11",
        allDay: true,
        eventTimezone: "UTC",
      },
    );

    expect(changes).toEqual([
      {
        field: "time",
        before: "2026-04-10 – 2026-04-11",
        after: "2026-04-10 – 2026-04-11",
        beforeAllDay: true,
        afterAllDay: true,
      },
    ]);
  });

  it("marks time change when only UTC instant changes", () => {
    const changes = computeMaterialEventChanges(
      {
        title: "Town Hall",
        startDate: "2026-04-10",
        endDate: null,
        allDay: true,
        eventTimezone: "Europe/Vienna",
        startAtUtc: "2026-04-09T22:00:00.000Z",
      },
      {
        title: "Town Hall",
        startDate: "2026-04-10",
        endDate: undefined,
        allDay: true,
        eventTimezone: "Europe/Vienna",
        startAtUtc: "2026-04-09T23:00:00.000Z",
      },
    );

    expect(changes).toEqual([
      {
        field: "time",
        before: "2026-04-10",
        after: "2026-04-10",
        beforeAllDay: true,
        afterAllDay: true,
      },
    ]);
  });
});
