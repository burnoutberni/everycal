export interface UtcDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export function buildStrictUtcDate(parts: UtcDateTimeParts): Date | null {
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
