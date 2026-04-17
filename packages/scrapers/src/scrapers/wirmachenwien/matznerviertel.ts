/**
 * Scraper for Lebenswertes Matznerviertel (matznerviertel.at).
 *
 * Uses The Events Calendar (Tribe) WordPress plugin with a REST API.
 */

import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";
import { fetchTribeEvents, fromTribeEvent } from "../../lib/tribe.js";

const API_URL = "https://matznerviertel.at/wp-json/tribe/events/v1/events?per_page=50&start_date=2020-01-01";

export class MatznerViertelScraper implements Scraper {
  readonly id = "matznerviertel";
  readonly name = "Lebenswertes Matznerviertel";
  readonly eventTimezone = "Europe/Vienna";
  readonly url = "https://matznerviertel.at/veranstaltungen/";
  readonly website = "https://www.matznerviertel.at";
  readonly bio = "Die Grätzlinitiative engagiert sich für einen lebenswerten öffentlichen Raum im Matznerviertel.";
  readonly avatarUrl = "https://matznerviertel.at/wp-content/uploads/2016/04/logo1w.png";
  readonly defaultEventImageUrl = "https://wirmachen.wien/wp-content/uploads/2023/12/Matznerviertel.jpeg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const tribeEvents = await fetchTribeEvents(API_URL);
    const events: Partial<EveryCalEvent>[] = [];

    for (const raw of tribeEvents) {
      const event = fromTribeEvent(raw, "matznerviertel");
      if (!event.title || !event.startDate) continue;

      const location = raw.venue
        ? {
            name: raw.venue.venue?.trim() || "Matznerviertel",
            address: [raw.venue.address, raw.venue.zip, raw.venue.city].filter(Boolean).join(", ") || undefined,
          }
        : { name: "Matznerviertel", address: "Matznerviertel, 1140 Wien" };

      events.push({
        ...event,
        description: event.description
          ? event.description.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
          : undefined,
        title: event.title.replace(/<[^>]+>/g, "").trim(),
        location,
        organizer: "Lebenswertes Matznerviertel",
        tags: ["wien", "bürgerinnen-initiative", "matznerviertel", "rudolfsheim-fünfhaus", "wirmachenwien"],
      });
    }

    return events;
  }
}
