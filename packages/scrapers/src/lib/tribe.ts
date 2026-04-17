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

const MAX_TRIBE_PAGES = 100;

export async function fetchTribeEvents(url: string): Promise<TribeEvent[]> {
  const events: TribeEvent[] = [];
  const seedUrl = new URL(url);
  let nextUrl: URL | undefined = seedUrl;
  let pageCount = 0;
  const visitedUrls = new Set<string>();

  while (nextUrl) {
    pageCount += 1;
    if (pageCount > MAX_TRIBE_PAGES) {
      throw new Error(`Tribe pagination exceeded ${MAX_TRIBE_PAGES} pages`);
    }

    const currentUrl = nextUrl.toString();
    if (visitedUrls.has(currentUrl)) {
      throw new Error(`Tribe pagination cycle detected for URL: ${currentUrl}`);
    }
    visitedUrls.add(currentUrl);

    const response = await fetch(currentUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch Tribe events API: ${response.status}`);
    }

    const payload = parseTribeEventsResponse(await response.json());
    events.push(...payload.events);
    nextUrl = getSafeNextUrl(payload.next_rest_url, seedUrl);
  }

  return events;
}

function parseTribeEventsResponse(payload: unknown): TribeEventsResponse {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid Tribe API payload: expected object");
  }

  const candidate = payload as {
    events?: unknown;
    next_rest_url?: unknown;
    code?: unknown;
    message?: unknown;
  };

  if (typeof candidate.code === "string") {
    const message = typeof candidate.message === "string" ? candidate.message : "Unknown error";
    throw new Error(`Tribe API returned error payload: ${candidate.code}: ${message}`);
  }

  if (candidate.events !== undefined && !Array.isArray(candidate.events)) {
    throw new Error("Invalid Tribe API payload: expected events array");
  }
  if (candidate.next_rest_url !== undefined && typeof candidate.next_rest_url !== "string") {
    throw new Error("Invalid Tribe API payload: expected next_rest_url string");
  }

  return {
    events: (candidate.events ?? []) as TribeEvent[],
    next_rest_url: candidate.next_rest_url,
  };
}

function getSafeNextUrl(nextRestUrl: string | undefined, seedUrl: URL): URL | undefined {
  if (!nextRestUrl) {
    return undefined;
  }

  let candidate: URL;
  try {
    candidate = new URL(nextRestUrl, seedUrl);
  } catch {
    throw new Error(`Invalid Tribe pagination URL: ${nextRestUrl}`);
  }

  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    throw new Error(`Unsafe Tribe pagination protocol: ${candidate.protocol}`);
  }
  if (candidate.origin !== seedUrl.origin) {
    throw new Error(`Unsafe Tribe pagination origin: ${candidate.origin}`);
  }

  return candidate;
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
