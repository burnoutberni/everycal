import { stripHtml, sanitizeHtml } from "./security.js";
import {
  datePartFromUtcInstantInTimezone,
  deriveEventEndAtUtc,
  deriveEventUtcRange,
  deriveUtcFromTemporalInput,
  isValidIanaTimezone,
} from "./timezone.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type MaterialEventChange = {
  field: "title" | "time" | "location";
  before?: string;
  after?: string;
  beforeAllDay?: boolean;
  afterAllDay?: boolean;
};

export type MaterialChangeSnapshot = {
  title: string;
  startDate: string;
  endDate?: string | null;
  allDay: boolean;
  eventTimezone?: string | null;
  startAtUtc?: string | null;
  endAtUtc?: string | null;
  locationName?: string | null;
  locationAddress?: string | null;
};

export function sanitizeEventWriteFields(body: Record<string, unknown>): void {
  if (typeof body.title === "string") body.title = stripHtml(body.title);
  if (typeof body.description === "string") body.description = sanitizeHtml(body.description);
  if (body.location && typeof body.location === "object") {
    const loc = body.location as Record<string, unknown>;
    if (typeof loc.name === "string") loc.name = stripHtml(loc.name);
    if (typeof loc.address === "string") loc.address = stripHtml(loc.address);
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) {
      body.tags = undefined;
    } else {
      const seenTags = new Set<string>();
      body.tags = body.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => stripHtml(tag))
        .map((tag) => tag.trim())
        .filter((tag) => {
          if (!tag || seenTags.has(tag)) return false;
          seenTags.add(tag);
          return true;
        });
    }
  }
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

export function deriveStoredDatePart(
  rawValue: string | null | undefined,
  utcValue: string | null | undefined,
  options: { allDay: boolean; eventTimezone: string },
): string | null {
  if (!rawValue) return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  if (options.allDay || isDateOnly(trimmed)) return trimmed.slice(0, 10);
  return datePartFromUtcInstantInTimezone(utcValue, options.eventTimezone) || trimmed.slice(0, 10);
}

export type NormalizedWriteInput = {
  startValue: string;
  endValue: string | null;
  eventTimezone: string;
  allDay: boolean;
};

function normalizeTemporalValue(
  value: unknown,
  options?: { nullable?: boolean },
): { value: string | null | undefined; invalid: boolean } {
  if (value === undefined) return { value: undefined, invalid: false };
  if (value === null) return options?.nullable ? { value: null, invalid: false } : { value: undefined, invalid: false };
  if (typeof value !== "string") return { value: undefined, invalid: true };
  const trimmed = value.trim();
  return { value: trimmed || undefined, invalid: false };
}

export function normalizeEventWriteInput(input: {
  startDate?: string | null;
  startDateTime?: string | null;
  endDate?: string | null;
  endDateTime?: string | null;
  eventTimezone?: string;
  allDay?: boolean;
  allowDateTimeFields: boolean;
}): NormalizedWriteInput | null {
  const normalizedStartDate = normalizeTemporalValue(input.startDate);
  const normalizedStartDateTime = normalizeTemporalValue(input.startDateTime);
  const normalizedEndDate = normalizeTemporalValue(input.endDate, { nullable: true });
  const normalizedEndDateTime = normalizeTemporalValue(input.endDateTime);
  if (
    normalizedStartDate.invalid
    || normalizedStartDateTime.invalid
    || normalizedEndDate.invalid
    || normalizedEndDateTime.invalid
  ) {
    return null;
  }
  const startDate = normalizedStartDate.value ?? undefined;
  const startDateTime = normalizedStartDateTime.value ?? undefined;
  const endDate = normalizedEndDate.value;
  const endDateTime = normalizedEndDateTime.value;
  const eventTimezone = input.eventTimezone?.trim() || undefined;
  const startValue = input.allowDateTimeFields
    ? (startDateTime || startDate)
    : startDate;
  const endValue = input.allowDateTimeFields
    ? (endDateTime !== undefined ? endDateTime : endDate)
    : endDate;
  if (!startValue || !eventTimezone) return null;

  const allDay = !!input.allDay;
  if (allDay) {
    if (input.allowDateTimeFields && (startDateTime !== undefined || endDateTime !== undefined)) {
      return null;
    }
    if (!startDate || !isDateOnly(startDate)) return null;
    if (endDate !== undefined && endDate !== null && !isDateOnly(endDate)) return null;
  }

  return {
    startValue,
    endValue: endValue ?? null,
    eventTimezone,
    allDay,
  };
}

export function deriveCanonicalTemporalFields(input: NormalizedWriteInput): {
  startAtUtc: string | null;
  endAtUtc: string | null;
  startOn: string | null;
  endOn: string | null;
} {
  const { startAtUtc, endAtUtc } = deriveEventUtcRange(
    input.startValue,
    input.endValue,
    { allDay: input.allDay, eventTimezone: input.eventTimezone },
  );
  const startOn = deriveStoredDatePart(input.startValue, startAtUtc, {
    allDay: input.allDay,
    eventTimezone: input.eventTimezone,
  }) || input.startValue.slice(0, 10);
  const endOn = deriveStoredDatePart(input.endValue, endAtUtc, {
    allDay: input.allDay,
    eventTimezone: input.eventTimezone,
  });
  return { startAtUtc, endAtUtc, startOn, endOn };
}

export function deriveUpdateTemporalFields(input: {
  nextStart?: string;
  nextEnd?: string | null;
  nextTimezone?: string;
  nextAllDay: boolean;
  existingStart: string;
  existingEnd: string | null;
  existingTimezone: string;
  shouldRecomputeUtcForTimezoneChange: boolean;
  shouldRecomputeAllDayEndBoundary: boolean;
}): {
  startForUtc: string | undefined;
  endForUtc: string | null | undefined;
  nextStartAtUtc: string | null;
  nextEndAtUtc: string | null;
  tzForConvert: string;
} {
  const tzForConvert = input.nextTimezone ?? input.existingTimezone;
  const startForUtc = input.nextStart
    ?? (input.shouldRecomputeUtcForTimezoneChange ? input.existingStart : undefined);
  const endForUtc = input.nextEnd !== undefined
    ? input.nextEnd
    : ((input.shouldRecomputeUtcForTimezoneChange || input.shouldRecomputeAllDayEndBoundary) ? input.existingEnd : undefined);
  const nextStartAtUtc = startForUtc !== undefined
    ? deriveUtcFromTemporalInput(startForUtc, { allDay: input.nextAllDay, eventTimezone: tzForConvert })
    : null;
  const baseStartForAllDayEnd = input.nextStart ?? input.existingStart;
  const nextEndAtUtc = endForUtc !== undefined
    ? deriveEventEndAtUtc(endForUtc, {
      allDay: input.nextAllDay,
      eventTimezone: tzForConvert,
      startValueForAllDay: baseStartForAllDayEnd,
    })
    : null;
  return { startForUtc, endForUtc, nextStartAtUtc, nextEndAtUtc, tzForConvert };
}

type TemporalValidationError = "invalid_datetime" | "request_failed";

type NormalizePartialTemporalUpdateInput = {
  startDate?: unknown;
  startDateTime?: unknown;
  endDate?: unknown;
  endDateTime?: unknown;
  eventTimezone?: unknown;
  allDay?: unknown;
  existingStart: string;
  existingEnd: string | null;
  existingAllDay: boolean;
  existingTimezoneRaw: string | null;
};

export type NormalizedPartialTemporalUpdate = {
  nextStart: string | undefined;
  nextEnd: string | null | undefined;
  nextTimezone: string | undefined;
  nextAllDay: boolean;
  existingTimezone: string;
  startForUtc: string | undefined;
  endForUtc: string | null | undefined;
  nextStartAtUtc: string | null;
  nextEndAtUtc: string | null;
  tzForConvert: string;
};

function normalizeOptionalTemporalString(
  value: unknown,
  options?: { allowNull?: boolean; nullMeansUndefined?: boolean },
): { value: string | null | undefined; invalid: boolean } {
  if (value === undefined) return { value: undefined, invalid: false };
  if (value === null) {
    if (!options?.allowNull) return { value: undefined, invalid: true };
    return { value: options.nullMeansUndefined ? undefined : null, invalid: false };
  }
  if (typeof value !== "string") return { value: undefined, invalid: true };
  const trimmed = value.trim();
  if (!trimmed) return { value: undefined, invalid: true };
  return { value: trimmed, invalid: false };
}

export function normalizePartialUpdateTemporalFields(
  input: NormalizePartialTemporalUpdateInput,
): { ok: true; value: NormalizedPartialTemporalUpdate } | { ok: false; error: TemporalValidationError } {
  const normalizedStartDate = normalizeOptionalTemporalString(input.startDate);
  const normalizedStartDateTime = normalizeOptionalTemporalString(input.startDateTime, {
    allowNull: true,
    nullMeansUndefined: true,
  });
  const normalizedEndDate = normalizeOptionalTemporalString(input.endDate, { allowNull: true });
  const normalizedEndDateTime = normalizeOptionalTemporalString(input.endDateTime, {
    allowNull: true,
    nullMeansUndefined: true,
  });
  if (
    normalizedStartDate.invalid
    || normalizedStartDateTime.invalid
    || normalizedEndDate.invalid
    || normalizedEndDateTime.invalid
  ) {
    return { ok: false, error: "invalid_datetime" };
  }
  if (input.allDay !== undefined && typeof input.allDay !== "boolean") {
    return { ok: false, error: "invalid_datetime" };
  }

  if (input.eventTimezone !== undefined && typeof input.eventTimezone !== "string") {
    return { ok: false, error: "request_failed" };
  }

  const nextTimezone = input.eventTimezone?.trim() || undefined;
  if (input.eventTimezone !== undefined && !nextTimezone) {
    return { ok: false, error: "request_failed" };
  }
  if (nextTimezone !== undefined && !isValidIanaTimezone(nextTimezone)) {
    return { ok: false, error: "request_failed" };
  }

  const nextStart = normalizedStartDateTime.value ?? normalizedStartDate.value ?? undefined;
  const nextEnd = normalizedEndDateTime.value !== undefined
    ? normalizedEndDateTime.value
    : normalizedEndDate.value;
  const existingTimezone = isValidIanaTimezone(input.existingTimezoneRaw || "")
    ? (input.existingTimezoneRaw as string)
    : "UTC";
  const nextAllDay = (input.allDay as boolean | undefined) ?? input.existingAllDay;
  if (nextAllDay) {
    if (normalizedStartDateTime.value !== undefined || normalizedEndDateTime.value !== undefined) {
      return { ok: false, error: "invalid_datetime" };
    }
    const candidateStart = (normalizedStartDate.value as string | undefined) ?? input.existingStart;
    const candidateEnd = normalizedEndDate.value !== undefined
      ? normalizedEndDate.value
      : input.existingEnd;
    if (!isDateOnly(candidateStart) || (candidateEnd !== null && candidateEnd !== undefined && !isDateOnly(candidateEnd))) {
      return { ok: false, error: "invalid_datetime" };
    }
  }
  const shouldRecomputeUtcForTimezoneChange = nextTimezone !== undefined;
  const shouldRecomputeAllDayEndBoundary = nextAllDay && (nextStart !== undefined || input.allDay !== undefined);
  const { startForUtc, endForUtc, nextStartAtUtc, nextEndAtUtc, tzForConvert } = deriveUpdateTemporalFields({
    nextStart,
    nextEnd,
    nextTimezone,
    nextAllDay,
    existingStart: input.existingStart,
    existingEnd: input.existingEnd,
    existingTimezone,
    shouldRecomputeUtcForTimezoneChange,
    shouldRecomputeAllDayEndBoundary,
  });

  if (startForUtc !== undefined && !nextStartAtUtc) {
    return { ok: false, error: "request_failed" };
  }
  if (endForUtc !== undefined && (nextAllDay ? !nextEndAtUtc : (endForUtc !== null && !nextEndAtUtc))) {
    return { ok: false, error: "request_failed" };
  }
  if (nextStartAtUtc && nextEndAtUtc && nextEndAtUtc < nextStartAtUtc) {
    return { ok: false, error: "request_failed" };
  }

  return {
    ok: true,
    value: {
      nextStart,
      nextEnd,
      nextTimezone,
      nextAllDay,
      existingTimezone,
      startForUtc,
      endForUtc,
      nextStartAtUtc,
      nextEndAtUtc,
      tzForConvert,
    },
  };
}

function formatTimeChangeValue(start: string, end: string | null | undefined): string {
  return [start, end || ""].filter(Boolean).join(" – ");
}

export function computeMaterialEventChanges(
  before: MaterialChangeSnapshot,
  after: MaterialChangeSnapshot,
): MaterialEventChange[] {
  const changes: MaterialEventChange[] = [];

  if (before.title !== after.title) {
    changes.push({ field: "title", before: before.title, after: after.title });
  }

  const beforeTime = formatTimeChangeValue(before.startDate, before.endDate);
  const afterTime = formatTimeChangeValue(after.startDate, after.endDate);
  const timeChanged = beforeTime !== afterTime
    || before.allDay !== after.allDay
    || (before.eventTimezone || "") !== (after.eventTimezone || "")
    || (before.startAtUtc || "") !== (after.startAtUtc || "")
    || (before.endAtUtc || "") !== (after.endAtUtc || "");
  if (timeChanged) {
    changes.push({
      field: "time",
      before: beforeTime,
      after: afterTime,
      beforeAllDay: before.allDay,
      afterAllDay: after.allDay,
    });
  }

  const beforeLocation = [before.locationName || "", before.locationAddress || ""].filter(Boolean).join(", ");
  const afterLocation = [after.locationName || "", after.locationAddress || ""].filter(Boolean).join(", ");
  if (beforeLocation !== afterLocation) {
    changes.push({ field: "location", before: beforeLocation, after: afterLocation });
  }

  return changes;
}
