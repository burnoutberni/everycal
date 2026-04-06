import { isValidVisibility, type EveryCalEvent } from "@everycal/core";
import { normalizeEventTimezone } from "./event-timezone.js";

export function rowToEvent(row: Record<string, unknown>): EveryCalEvent {
  const visibility = isValidVisibility(row.visibility) ? row.visibility : "public";
  const allDay = !!row.all_day;
  const startAtUtc = (row.start_at_utc as string | null | undefined) ?? undefined;
  const timezoneQuality = (row.timezone_quality as "exact_tzid" | "offset_only" | null | undefined) ?? undefined;
  const eventTimezone = timezoneQuality === "offset_only"
    ? undefined
    : normalizeEventTimezone(row.event_timezone);

  if (!allDay && !startAtUtc) {
    throw new Error("Timed event missing start_at_utc");
  }

  const baseEvent = {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string | null | undefined) ?? undefined,
    startDate: row.start_date as string,
    endDate: (row.end_date as string | null | undefined) ?? undefined,
    endAtUtc: (row.end_at_utc as string | null | undefined) ?? undefined,
    eventTimezone,
    timezoneQuality,
    location: row.location_name
      ? {
          name: row.location_name as string,
          address: (row.location_address as string | null | undefined) ?? undefined,
          latitude: (row.location_latitude as number | null | undefined) ?? undefined,
          longitude: (row.location_longitude as number | null | undefined) ?? undefined,
          url: (row.location_url as string | null | undefined) ?? undefined,
        }
      : undefined,
    image: row.image_url
      ? {
          url: row.image_url as string,
          mediaType: (row.image_media_type as string | null | undefined) ?? undefined,
          alt: (row.image_alt as string | null | undefined) ?? undefined,
        }
      : undefined,
    url: (row.url as string | null | undefined) ?? undefined,
    tags: row.tags ? (row.tags as string).split(",") : undefined,
    visibility,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };

  if (allDay) {
    return {
      ...baseEvent,
      allDay: true,
      ...(startAtUtc ? { startAtUtc } : {}),
    };
  }

  return {
    ...baseEvent,
    allDay: false,
    startAtUtc: startAtUtc as string,
  };
}
