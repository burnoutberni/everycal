import { isValidIanaTimezone } from "./timezone.js";

export const DEFAULT_EVENT_TIMEZONE = "UTC";

export function normalizeEventTimezone(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_EVENT_TIMEZONE;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_EVENT_TIMEZONE;
  return isValidIanaTimezone(trimmed) ? trimmed : DEFAULT_EVENT_TIMEZONE;
}
