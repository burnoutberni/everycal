/**
 * Scraper for Lebenswertes Matznerviertel (matznerviertel.at).
 *
 * Uses The Events Calendar (Tribe) WordPress plugin with a REST API.
 * Events are fetched from the Tribe Events V1 JSON API.
 */

import * as cheerio from "cheerio";
import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";

const API_URL = "https://matznerviertel.at/wp-json/tribe/events/v1/events";

/** Decode HTML entities like &#8218; and &amp; */
function decodeHtmlEntities(text: string): string {
  return cheerio.load(`<p>${text}</p>`)("p").text();
}

interface TribeEvent {
  id: number;
  url: string;
  title: string;
  description: string;
  start_date: string;
  end_date: string;
  all_day: boolean;
  venue?: {
    venue: string;
    address?: string;
    city?: string;
    zip?: string;
  };
  image?: {
    url: string;
    alt?: string;
  };
}

export class MatznerViertelScraper implements Scraper {
  readonly id = "matznerviertel";
  readonly name = "Lebenswertes Matznerviertel";
  readonly url = "https://matznerviertel.at/veranstaltungen/";
  readonly website = "https://www.matznerviertel.at";
  readonly bio = "Die Grätzlinitiative engagiert sich für einen lebenswerten öffentlichen Raum im Matznerviertel.";
  readonly avatarUrl = "https://wirmachen.wien/wp-content/uploads/2023/12/Matznerviertel.jpeg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await fetch(`${API_URL}?per_page=50&start_date=2020-01-01`);
    if (!response.ok) {
      throw new Error(`Failed to fetch Matznerviertel events: ${response.status}`);
    }

    const json = (await response.json()) as { events: TribeEvent[] };
    const events: Partial<EveryCalEvent>[] = [];

    for (const ev of json.events) {
      if (!ev.title || !ev.start_date) continue;

      // Strip HTML tags from description
      const description = ev.description
        ? ev.description.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
        : undefined;

      const location = ev.venue
        ? {
            name: ev.venue.venue,
            address: [ev.venue.address, ev.venue.zip, ev.venue.city].filter(Boolean).join(", ") || undefined,
          }
        : { name: "Matznerviertel", address: "Matznerviertel, 1140 Wien" };

      events.push({
        id: `matznerviertel-${ev.id}`,
        title: decodeHtmlEntities(ev.title.replace(/<[^>]+>/g, "").trim()),
        description: description || undefined,
        startDate: new Date(ev.start_date).toISOString(),
        endDate: ev.end_date ? new Date(ev.end_date).toISOString() : undefined,
        allDay: ev.all_day,
        url: ev.url,
        location,
        image: ev.image ? { url: ev.image.url, alt: ev.image.alt } : undefined,
        organizer: "Lebenswertes Matznerviertel",
        tags: ["vienna", "civic-initiative", "matznerviertel", "wirmachen-wien"],
        visibility: "public",
      });
    }

    return events;
  }
}
