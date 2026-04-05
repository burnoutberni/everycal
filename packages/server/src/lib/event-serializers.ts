import { formatRemoteActorAccount } from "./federation.js";

function parseImageAttribution(value: unknown): unknown | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value as string);
  } catch {
    return undefined;
  }
}

function localTimezoneQuality(eventTimezone: unknown): "exact_tzid" | undefined {
  if (typeof eventTimezone !== "string") return undefined;
  return eventTimezone.trim() ? "exact_tzid" : undefined;
}

export function serializeLocalEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    source: "local",
    accountId: row.account_id,
    account: row.account_username
      ? { username: row.account_username, displayName: row.account_display_name }
      : undefined,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    startAtUtc: row.start_at_utc ?? undefined,
    endAtUtc: row.end_at_utc ?? undefined,
    eventTimezone: row.event_timezone ?? undefined,
    timezoneQuality: localTimezoneQuality(row.event_timezone),
    allDay: !!row.all_day,
    location: row.location_name
      ? {
          name: row.location_name,
          address: row.location_address,
          latitude: row.location_latitude,
          longitude: row.location_longitude,
          url: row.location_url,
        }
      : null,
    image: row.image_url
      ? {
          url: row.image_url,
          mediaType: row.image_media_type,
          alt: row.image_alt,
          attribution: parseImageAttribution(row.image_attribution),
        }
      : null,
    ogImageUrl: row.og_image_url || null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: row.visibility,
    canceled: !!row.canceled,
    repostedBy: row.repost_username
      ? { username: row.repost_username as string, displayName: row.repost_display_name as string | null }
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeRemoteEvent(row: Record<string, unknown>): Record<string, unknown> {
  const account = formatRemoteActorAccount({
    status: row.actor_fetch_status as string | null,
    preferredUsername: row.preferred_username as string | null,
    displayName: row.actor_display_name as string | null,
    domain: row.domain as string | null,
    iconUrl: row.actor_icon_url as string | null,
  });
  return {
    id: row.uri,
    slug: row.slug,
    source: "remote",
    actorUri: row.actor_uri,
    account,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    startAtUtc: row.start_at_utc ?? undefined,
    endAtUtc: row.end_at_utc ?? undefined,
    eventTimezone: row.event_timezone ?? undefined,
    timezoneQuality: row.timezone_quality as "exact_tzid" | "offset_only" | undefined,
    allDay: !!row.all_day,
    location: row.location_name
      ? {
          name: row.location_name,
          address: row.location_address,
          latitude: row.location_latitude,
          longitude: row.location_longitude,
        }
      : null,
    image: row.image_url
      ? {
          url: row.image_url,
          mediaType: row.image_media_type,
          alt: row.image_alt,
          attribution: parseImageAttribution(row.image_attribution),
        }
      : null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: "public",
    canceled: !!row.canceled,
    createdAt: row.published,
    updatedAt: row.updated,
  };
}
