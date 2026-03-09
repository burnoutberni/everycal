const ISO_HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

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
  return asUtc - instant.getTime();
}

function localInZoneToUtcIso(localIso: string, timeZone: string): string {
  const m = localIso.match(LOCAL_DATE_TIME);
  if (!m) {
    return new Date(localIso).toISOString();
  }

  const [, y, mo, d, h, mi, s] = m;
  const naiveUtcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || "0"));

  // Iterative resolution for DST boundaries: offset depends on final instant.
  let candidateMs = naiveUtcMs;
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(candidateMs), timeZone);
    const next = naiveUtcMs - offset;
    if (next === candidateMs) break;
    candidateMs = next;
  }

  return new Date(candidateMs).toISOString();
}

export function convertLegacyNaiveToUtcIso(value: string, fallbackTimezone: string): string {
  if (!value) return value;

  if (ISO_HAS_OFFSET.test(value)) {
    return new Date(value).toISOString();
  }

  const tz = isValidIanaTimezone(fallbackTimezone) ? fallbackTimezone : "Europe/Vienna";

  if (DATE_ONLY.test(value)) {
    return localInZoneToUtcIso(`${value}T00:00:00`, tz);
  }

  return localInZoneToUtcIso(value, tz);
}
