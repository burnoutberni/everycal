const ISO_HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;

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
  const m = localIso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date(localIso).toISOString();
  const [, y, mo, d, h, mi, s] = m;
  const guess = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || "0")));
  const offset = getTimeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset).toISOString();
}

export function convertLegacyNaiveToUtcIso(value: string, fallbackTimezone: string): string {
  if (!value) return value;
  if (ISO_HAS_OFFSET.test(value)) {
    return new Date(value).toISOString();
  }
  const tz = isValidIanaTimezone(fallbackTimezone) ? fallbackTimezone : "Europe/Vienna";
  return localInZoneToUtcIso(value, tz);
}
