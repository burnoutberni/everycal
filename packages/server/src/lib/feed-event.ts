import { isValidVisibility, type EveryCalEvent } from "@everycal/core";

export function rowToEvent(row: Record<string, unknown>): EveryCalEvent {
  const visibility = isValidVisibility(row.visibility) ? row.visibility : "public";

  return {
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | undefined,
    startDate: row.start_date as string,
    endDate: row.end_date as string | undefined,
    startAtUtc: row.start_at_utc as string | undefined,
    endAtUtc: row.end_at_utc as string | undefined,
    eventTimezone: row.event_timezone as string | undefined,
    timezoneQuality: row.timezone_quality as "exact_tzid" | "offset_only" | "unknown" | undefined,
    allDay: !!row.all_day,
    location: row.location_name
      ? {
          name: row.location_name as string,
          address: row.location_address as string | undefined,
          latitude: row.location_latitude as number | undefined,
          longitude: row.location_longitude as number | undefined,
          url: row.location_url as string | undefined,
        }
      : undefined,
    image: row.image_url
      ? {
          url: row.image_url as string,
          mediaType: row.image_media_type as string | undefined,
          alt: row.image_alt as string | undefined,
        }
      : undefined,
    url: row.url as string | undefined,
    tags: row.tags ? (row.tags as string).split(",") : undefined,
    visibility,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
