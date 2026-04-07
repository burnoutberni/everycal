const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i;
const RFC2822_WITH_ZONE = /,\s*\d{1,2}\s+\w{3}\s+\d{4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}|GMT|UTC)\s*$/i;

function normalizeDateTimeSeparator(value: string): string {
  return value.includes(" ") ? value.replace(" ", "T") : value;
}

export function normalizeEventDateTime(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (DATE_ONLY.test(trimmed) || LOCAL_DATE_TIME.test(trimmed) || DATE_TIME_WITH_OFFSET.test(trimmed)) {
    return normalizeDateTimeSeparator(trimmed);
  }

  return undefined;
}

export function toUtcIsoFromAbsolute(value?: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const normalized = normalizeEventDateTime(trimmed);
  if (normalized && DATE_TIME_WITH_OFFSET.test(normalized)) {
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  if (RFC2822_WITH_ZONE.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  return undefined;
}

export function normalizeUtcDateTime(value?: string | null): string | undefined {
  const normalized = normalizeEventDateTime(value);
  if (!normalized || DATE_ONLY.test(normalized)) return undefined;
  if (DATE_TIME_WITH_OFFSET.test(normalized)) {
    return toUtcIsoFromAbsolute(normalized);
  }
  return `${normalized}Z`;
}
