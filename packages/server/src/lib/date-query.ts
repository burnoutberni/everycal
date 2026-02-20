/**
 * Helpers for date range queries. Handles both ISO format (2025-02-28T22:59:59.999Z)
 * and date-only format (20250228) from iCal, which sort differently in string comparison.
 */

/** Convert ISO end-of-day to compact format so date-only YYYYMMDD is included in <= comparison. */
export function toCompactEnd(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.?(\d{0,3})Z?$/);
  if (!m) return iso;
  const ms = (m[7] || "000").padEnd(3, "0").slice(0, 3);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}.${ms}Z`;
}

/**
 * Build SQL fragment and params for start_date <= to, including date-only format.
 * Use: sql += buildToCondition("re.start_date"); params.push(...buildToParams(to));
 */
export function buildToCondition(column: string): string {
  return ` AND (${column} <= ? OR (${column} GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND ${column} <= ?))`;
}

export function buildToParams(to: string): [string, string] {
  return [to, toCompactEnd(to)];
}
