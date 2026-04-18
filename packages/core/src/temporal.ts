const ISO_HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

export interface DeriveUtcFromTemporalInputOptions {
  allDay: boolean;
  eventTimezone: string | null;
}

export interface DeriveEventEndAtUtcOptions extends DeriveUtcFromTemporalInputOptions {
  startValueForAllDay: string;
}

export interface DerivedEventUtcRange {
  startAtUtc: string | null;
  endAtUtc: string | null;
}

interface UtcDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function buildStrictUtcDate(parts: UtcDateTimeParts): Date | null {
  const instant = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      parts.millisecond,
    ),
  );

  if (Number.isNaN(instant.getTime())) return null;
  if (
    instant.getUTCFullYear() !== parts.year
    || instant.getUTCMonth() !== parts.month - 1
    || instant.getUTCDate() !== parts.day
    || instant.getUTCHours() !== parts.hour
    || instant.getUTCMinutes() !== parts.minute
    || instant.getUTCSeconds() !== parts.second
    || instant.getUTCMilliseconds() !== parts.millisecond
  ) {
    return null;
  }

  return instant;
}

function parseDateOnlyParts(value: string): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const strict = buildStrictUtcDate({
    year,
    month,
    day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  if (!strict) return null;
  return { year, month, day };
}

function formatDateOnlyUtc(instant: Date): string {
  const year = instant.getUTCFullYear();
  const month = String(instant.getUTCMonth() + 1).padStart(2, "0");
  const day = String(instant.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToDateOnly(value: string, days: number): string | null {
  const parsed = parseDateOnlyParts(value);
  if (!parsed) return null;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return formatDateOnlyUtc(shifted);
}

export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute), Number(map.second));
  const instantUtcSecond = Date.UTC(
    instant.getUTCFullYear(),
    instant.getUTCMonth(),
    instant.getUTCDate(),
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
  );
  return asUtc - instantUtcSecond;
}

function absoluteIsoWithOffsetToUtcIso(value: string): string | null {
  if (!ISO_HAS_OFFSET.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function localDateTimeWithTimezoneToUtcIso(localIso: string, timeZone: string): string | null {
  if (!isValidIanaTimezone(timeZone)) return null;
  const normalized = localIso.includes(" ") ? localIso.replace(" ", "T") : localIso;
  const m = normalized.match(LOCAL_DATE_TIME);
  if (!m) return null;

  const [, y, mo, d, h, mi, s, frac] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s || "0");
  const milliseconds = frac ? Number(frac.padEnd(3, "0")) : 0;
  const naiveUtc = buildStrictUtcDate({
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: milliseconds,
  });
  if (!naiveUtc) return null;
  const naiveUtcMs = naiveUtc.getTime();

  let candidateMs = naiveUtcMs;
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(candidateMs), timeZone);
    const next = naiveUtcMs - offset;
    if (next === candidateMs) break;
    candidateMs = next;
  }

  const parsed = new Date(candidateMs);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function datePartFromUtcInstantInTimezone(
  utcIso: string | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (!utcIso || !timeZone || !isValidIanaTimezone(timeZone)) return null;
  const parsed = new Date(utcIso);
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const year = map.year;
  const month = map.month;
  const day = map.day;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

export function deriveUtcFromTemporalInput(
  value: string | null | undefined,
  options: DeriveUtcFromTemporalInputOptions,
): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (ISO_HAS_OFFSET.test(normalized)) return absoluteIsoWithOffsetToUtcIso(normalized);

  if (DATE_ONLY.test(normalized)) {
    if (!options.allDay || !options.eventTimezone) return null;
    return localDateTimeWithTimezoneToUtcIso(`${normalized}T00:00:00`, options.eventTimezone);
  }

  if (!options.eventTimezone) return null;
  return localDateTimeWithTimezoneToUtcIso(normalized, options.eventTimezone);
}

export function deriveAllDayEndAtUtc(
  startDate: string,
  endDate: string | null | undefined,
  eventTimezone: string | null,
): string | null {
  const inclusiveEnd = endDate || startDate;
  if (DATE_ONLY.test(inclusiveEnd)) {
    const exclusiveEnd = addDaysToDateOnly(inclusiveEnd, 1);
    if (!exclusiveEnd) return null;
    return deriveUtcFromTemporalInput(exclusiveEnd, { allDay: true, eventTimezone });
  }
  return deriveUtcFromTemporalInput(inclusiveEnd, { allDay: true, eventTimezone });
}

export function deriveEventEndAtUtc(
  endValue: string | null | undefined,
  options: DeriveEventEndAtUtcOptions,
): string | null {
  if (options.allDay) {
    return deriveAllDayEndAtUtc(options.startValueForAllDay, endValue ?? null, options.eventTimezone);
  }
  if (!endValue) return null;
  return deriveUtcFromTemporalInput(endValue, { allDay: false, eventTimezone: options.eventTimezone });
}

export function deriveEventUtcRange(
  startValue: string | null | undefined,
  endValue: string | null | undefined,
  options: DeriveUtcFromTemporalInputOptions,
): DerivedEventUtcRange {
  if (!startValue) return { startAtUtc: null, endAtUtc: null };
  return {
    startAtUtc: deriveUtcFromTemporalInput(startValue, options),
    endAtUtc: deriveEventEndAtUtc(endValue, {
      allDay: options.allDay,
      eventTimezone: options.eventTimezone,
      startValueForAllDay: startValue,
    }),
  };
}
