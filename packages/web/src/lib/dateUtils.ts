/** Extract YYYY-MM-DD in local timezone from an ISO date string. */
export function toLocalYMD(isoString: string): string {
  const d = new Date(isoString);
  return dateToLocalYMD(d);
}

/** Extract YYYY-MM-DD in local timezone from a Date. */
export function dateToLocalYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Start/end of day as ISO strings for API from/to params.
 * Uses UTC boundaries for the selected calendar date so events at 11pm UTC
 * (e.g. 11pm Vienna time) are included regardless of viewer timezone.
 */
export function startOfDayForApi(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  return new Date(Date.UTC(y, m, day, 0, 0, 0, 0)).toISOString();
}

export function endOfDayForApi(d: Date): string {
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  return new Date(Date.UTC(y, m, day, 23, 59, 59, 999)).toISOString();
}
