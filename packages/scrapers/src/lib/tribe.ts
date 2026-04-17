import type { EveryCalEvent } from "@everycal/core";
import { normalizeEventDateTime, normalizeUtcDateTime } from "./datetime.js";

export interface TribeCategory {
  name: string;
}

export interface TribeImage {
  url?: string;
  alt?: string;
}

export interface TribeVenue {
  venue?: string;
  address?: string;
  city?: string;
  zip?: string;
}

export interface TribeEvent {
  id: number;
  title?: string;
  description?: string;
  url?: string;
  image?: TribeImage;
  categories?: TribeCategory[];
  venue?: TribeVenue;
  utc_start_date?: string;
  utc_end_date?: string;
  start_date?: string;
  end_date?: string;
  all_day?: boolean;
}

interface TribeEventsResponse {
  events: TribeEvent[];
  next_rest_url?: string;
}

export async function fetchTribeEvents(url: string): Promise<TribeEvent[]> {
  const events: TribeEvent[] = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch Tribe events API: ${response.status}`);
    }

    const payload = (await response.json()) as TribeEventsResponse;
    events.push(...(payload.events || []));
    nextUrl = payload.next_rest_url || "";
  }

  return events;
}

export function fromTribeEvent(
  raw: TribeEvent,
  idPrefix: string,
): Partial<EveryCalEvent> {
  const startDate = raw.utc_start_date
    ? normalizeUtcDateTime(raw.utc_start_date)
    : normalizeEventDateTime(raw.start_date);
  const endDate = raw.utc_end_date
    ? normalizeUtcDateTime(raw.utc_end_date)
    : normalizeEventDateTime(raw.end_date);

  const event: Partial<EveryCalEvent> = {
    id: `${idPrefix}-${raw.id}`,
    title: raw.title,
    description: raw.description || undefined,
    startDate,
    endDate,
    allDay: Boolean(raw.all_day),
    url: raw.url,
    visibility: "public",
  };

  if (raw.image?.url) {
    event.image = {
      url: raw.image.url,
      alt: raw.image.alt,
      mediaType: inferMediaType(raw.image.url),
    };
  }

  return event;
}

function inferMediaType(url: string): string | undefined {
  const lower = url.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return undefined;
}

export function toTribeDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
