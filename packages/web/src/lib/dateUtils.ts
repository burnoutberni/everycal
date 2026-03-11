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

/** Format date for section headings (e.g. "Monday, Jan 15, 2025"). */
export function formatDateHeading(d: Date, locale?: string): string {
  return d.toLocaleDateString(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Group events by local YYYY-MM-DD. */
export function groupEventsByDate<T extends { startDate: string }>(
  events: T[],
  getKey: (ev: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const ev of events) {
    const key = getKey(ev);
    const list = groups.get(key) || [];
    list.push(ev);
    groups.set(key, list);
  }
  return groups;
}

/**
 * Given sorted YYYY-MM-DD keys, resolve best target when exact date has no events.
 * preferEarlier=true picks closest earlier date first, then later.
 */
export function resolveNearestDateKey(sortedKeys: string[], targetYmd: string, preferEarlier = true): string | null {
  if (sortedKeys.length === 0) return null;
  let lower: string | null = null;
  let upper: string | null = null;

  for (const key of sortedKeys) {
    if (key === targetYmd) return key;
    if (key < targetYmd) {
      lower = key;
      continue;
    }
    if (key > targetYmd) {
      upper = key;
      break;
    }
  }

  return preferEarlier ? (lower ?? upper) : (upper ?? lower);
}
