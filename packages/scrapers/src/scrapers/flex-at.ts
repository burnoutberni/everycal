/**
 * Scraper for Flex Vienna (flex.at).
 *
 * Flex uses The Events Calendar (Tribe) WP plugin.
 * We consume its public REST API directly.
 */

import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../scraper.js";

interface TribeCategory {
  name: string;
}

interface TribeImage {
  url?: string;
}

interface TribeEvent {
  id: number;
  title?: string;
  description?: string;
  url?: string;
  image?: TribeImage;
  categories?: TribeCategory[];
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

export class FlexScraper implements Scraper {
  readonly id = "flex_at";
  readonly name = "Flex Vienna";
  readonly eventTimezone = "Europe/Vienna";
  readonly url = "https://flex.at/wp-json/tribe/events/v1/events";
  readonly avatarUrl = "https://flex.at/wp-content/uploads/2022/05/Flex-Logo-weiss.svg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const events: Partial<EveryCalEvent>[] = [];

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const end = new Date(start);
    end.setMonth(end.getMonth() + 24);

    let nextUrl = `${this.url}?status=publish&per_page=100&start_date=${encodeURIComponent(toTribeDate(start))}&end_date=${encodeURIComponent(toTribeDate(end))}`;

    while (nextUrl) {
      const response = await fetch(nextUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch Flex events API: ${response.status}`);
      }

      const payload = (await response.json()) as TribeEventsResponse;
      for (const raw of payload.events || []) {
        const event = fromTribeEvent(raw);
        if (!event.title || !event.startDate) continue;

        event.location = {
          name: "Flex",
          address: "Donaukanal / Augartenbrucke, 1010 Wien",
          latitude: 48.2177763,
          longitude: 16.370909,
          url: "https://flex.at",
        };

        const categoryTags = (raw.categories || [])
          .map((c) => c.name?.trim().toLowerCase())
          .filter((c): c is string => Boolean(c));

        const tags = new Set([...(event.tags || []), ...categoryTags, "wien", "music"]);
        event.tags = Array.from(tags);

        events.push(event);
      }

      nextUrl = payload.next_rest_url || "";
    }

    return events;
  }
}

function fromTribeEvent(raw: TribeEvent): Partial<EveryCalEvent> {
  const event: Partial<EveryCalEvent> = {
    id: `flex-at-${raw.id}`,
    title: raw.title,
    description: raw.description || undefined,
    startDate: toIsoDate(raw.utc_start_date || raw.start_date),
    endDate: toIsoDate(raw.utc_end_date || raw.end_date),
    allDay: Boolean(raw.all_day),
    url: raw.url,
    visibility: "public",
  };

  if (raw.image?.url) {
    event.image = {
      url: raw.image.url,
      mediaType: inferMediaType(raw.image.url),
    };
  }

  return event;
}

function toTribeDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function toIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(" ", "T");
  return normalized.endsWith("Z") ? normalized : `${normalized}Z`;
}

function inferMediaType(url: string): string | undefined {
  const lower = url.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return undefined;
}
