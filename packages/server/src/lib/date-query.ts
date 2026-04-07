import { buildStrictUtcDate } from "./utc-date.js";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_DATE_TIME_NO_OFFSET =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

export interface ParsedDateQueryBound {
  kind: "date" | "instant";
  instant: string;
  date: string | null;
}

export interface ParsedDateRangeParams {
  from?: ParsedDateQueryBound;
  to?: ParsedDateQueryBound;
}

export interface DateRangeFilterColumns {
  instantColumn: string;
  dateColumn: string;
}

export class DateQueryParamError extends Error {
  constructor(public readonly param: "from" | "to", detail: string) {
    super(`Invalid '${param}' query param: ${detail}`);
    this.name = "DateQueryParamError";
  }
}

function parseDateOnlyUtc(value: string, endOfDay: boolean): string | null {
  const m = value.match(DATE_ONLY);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = endOfDay ? 23 : 0;
  const minute = endOfDay ? 59 : 0;
  const second = endOfDay ? 59 : 0;
  const millisecond = endOfDay ? 999 : 0;

  const instant = buildStrictUtcDate({
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  });
  if (!instant) return null;
  return instant.toISOString();
}

function normalizeQueryInstant(value: string, param: "from" | "to"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new DateQueryParamError(param, "value cannot be empty");

  const dateOnly = parseDateOnlyUtc(trimmed, param === "to");
  if (dateOnly) return dateOnly;

  if (ISO_HAS_OFFSET.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new DateQueryParamError(param, "datetime is not parseable");
    }
    return parsed.toISOString();
  }

  if (LOCAL_DATE_TIME_NO_OFFSET.test(trimmed)) {
    throw new DateQueryParamError(
      param,
      "local datetime must include an offset or Z suffix (for example: 2026-04-13T09:30:00Z)",
    );
  }

  throw new DateQueryParamError(
    param,
    "expected YYYY-MM-DD or an ISO 8601 datetime with offset/Z",
  );
}

function parseQueryBound(value: string, param: "from" | "to"): ParsedDateQueryBound {
  const trimmed = value.trim();
  if (!trimmed) throw new DateQueryParamError(param, "value cannot be empty");

  const dateOnly = parseDateOnlyUtc(trimmed, param === "to");
  if (dateOnly) {
    return {
      kind: "date",
      instant: dateOnly,
      date: trimmed,
    };
  }

  if (ISO_HAS_OFFSET.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new DateQueryParamError(param, "datetime is not parseable");
    }
    return {
      kind: "instant",
      instant: parsed.toISOString(),
      date: null,
    };
  }

  if (LOCAL_DATE_TIME_NO_OFFSET.test(trimmed)) {
    throw new DateQueryParamError(
      param,
      "local datetime must include an offset or Z suffix (for example: 2026-04-13T09:30:00Z)",
    );
  }

  throw new DateQueryParamError(
    param,
    "expected YYYY-MM-DD or an ISO 8601 datetime with offset/Z",
  );
}

export function parseDateRangeParams(
  from?: string,
  to?: string,
): ParsedDateRangeParams {
  const parsedFrom = from ? parseQueryBound(from, "from") : undefined;
  const parsedTo = to ? parseQueryBound(to, "to") : undefined;
  if (parsedFrom && parsedTo && parsedFrom.instant > parsedTo.instant) {
    throw new DateQueryParamError("to", "must be greater than or equal to 'from'");
  }
  return { from: parsedFrom, to: parsedTo };
}

export function normalizeDateRangeParams(
  from?: string,
  to?: string,
): { from?: string; to?: string } {
  const parsed = parseDateRangeParams(from, to);
  return {
    from: parsed.from?.instant,
    to: parsed.to?.instant,
  };
}

export function buildDateRangeFilter(
  columns: DateRangeFilterColumns,
  from?: string,
  to?: string,
): { sql: string; params: string[] } {
  const parsed = parseDateRangeParams(from, to);
  let sql = "";
  const params: string[] = [];

  if (parsed.from) {
    if (parsed.from.kind === "date" && parsed.from.date) {
      sql += ` AND ${columns.dateColumn} >= ?`;
      params.push(parsed.from.date);
    } else {
      sql += ` AND ${columns.instantColumn} >= ?`;
      params.push(parsed.from.instant);
    }
  }

  if (parsed.to) {
    if (parsed.to.kind === "date" && parsed.to.date) {
      sql += ` AND ${columns.dateColumn} <= ?`;
      params.push(parsed.to.date);
    } else {
      sql += ` AND ${columns.instantColumn} <= ?`;
      params.push(parsed.to.instant);
    }
  }

  return { sql, params };
}

/** Build SQL fragment and params for UTC start_at_utc >= from instant. */
export function buildFromCondition(column: string): string {
  return ` AND ${column} >= ?`;
}

export function buildFromParams(from: string): [string] {
  return [normalizeQueryInstant(from, "from")];
}

/** Build SQL fragment and params for UTC start_at_utc <= to instant. */
export function buildToCondition(column: string): string {
  return ` AND ${column} <= ?`;
}

export function buildToParams(to: string): [string] {
  return [normalizeQueryInstant(to, "to")];
}
