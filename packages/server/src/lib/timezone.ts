import {
  deriveEventEndAtUtc,
  deriveUtcFromTemporalInput,
  isValidIanaTimezone,
} from "@everycal/core";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateOnly(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(instant.getTime())
    && instant.getUTCFullYear() === year
    && instant.getUTCMonth() === month - 1
    && instant.getUTCDate() === day
  );
}

export function extractDatePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return isValidDateOnly(trimmed) ? trimmed : null;
  const prefix = trimmed.slice(0, 10);
  return DATE_ONLY.test(prefix) && isValidDateOnly(prefix) ? prefix : null;
}

export type TimezoneQuality = "exact_tzid" | "offset_only";

export interface NormalizedRemoteTemporal {
  startDate: string;
  endDate: string | null;
  allDay: boolean;
  startAtUtc: string;
  endAtUtc: string | null;
  eventTimezone: string | null;
  timezoneQuality: TimezoneQuality;
}

export {
  isValidIanaTimezone,
  localDateTimeWithTimezoneToUtcIso,
  datePartFromUtcInstantInTimezone,
  deriveUtcFromTemporalInput,
  deriveAllDayEndAtUtc,
  deriveEventEndAtUtc,
  deriveEventUtcRange,
} from "@everycal/core";

export type {
  DeriveUtcFromTemporalInputOptions,
  DeriveEventEndAtUtcOptions,
  DerivedEventUtcRange,
} from "@everycal/core";

function resolveTimezoneHint(object: Record<string, unknown>): string | null {
  const candidates = [object.eventTimezone, object.timezone, object.tzid];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const tz = candidate.trim();
    if (tz && isValidIanaTimezone(tz)) return tz;
  }
  return null;
}

export function normalizeApTemporal(object: Record<string, unknown>): NormalizedRemoteTemporal | null {
  const startRaw = typeof (object.startTime ?? object.startDate) === "string"
    ? String(object.startTime ?? object.startDate).trim()
    : "";
  if (!startRaw) return null;

  const endRawSource = object.endTime ?? object.endDate;
  const endRaw = typeof endRawSource === "string" ? String(endRawSource).trim() : null;
  const explicitAllDay = typeof object.allDay === "boolean" ? object.allDay : null;
  const inferredAllDay = DATE_ONLY.test(startRaw) && (!endRaw || DATE_ONLY.test(endRaw));
  const allDay = explicitAllDay ?? inferredAllDay;

  const eventTimezone = resolveTimezoneHint(object);
  const startAtUtc = deriveUtcFromTemporalInput(startRaw, { allDay, eventTimezone });
  if (!startAtUtc) return null;

  const endAtUtc = deriveEventEndAtUtc(endRaw, {
    allDay,
    eventTimezone,
    startValueForAllDay: startRaw,
  });
  if ((allDay || endRaw) && !endAtUtc) return null;
  if (endAtUtc && endAtUtc < startAtUtc) return null;

  const timezoneQuality = eventTimezone ? "exact_tzid" : "offset_only";

  return {
    startDate: startRaw,
    endDate: endRaw,
    allDay,
    startAtUtc,
    endAtUtc,
    eventTimezone,
    timezoneQuality,
  };
}
