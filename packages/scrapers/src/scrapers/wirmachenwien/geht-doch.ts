/**
 * Scraper for GEHT-DOCH (geht-doch.info).
 *
 * Uses The Events Calendar (Tribe) WordPress plugin with a REST API.
 */

import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";
import { fetchTribeEvents, fromTribeEvent, toTribeDate } from "../../lib/tribe.js";

const API_URL = "https://geht-doch.info/wp-json/tribe/events/v1/events";

function normalizeCategoryTag(value: string | undefined): string | undefined {
  const base = value?.trim().toLowerCase().replace(/^#/, "");
  if (!base) return undefined;
  return base.replace(/\s+/g, "-").replace(/-+/g, "-");
}

export class GehtDochScraper implements Scraper {
  readonly id = "geht_doch";
  readonly name = "GEHT-DOCH";
  readonly eventTimezone = "Europe/Vienna";
  readonly url = "https://geht-doch.info/termine/";
  readonly website = "https://geht-doch.info/";
  readonly bio = "GEHT-DOCH ist ein zivilgesellschaftlich organisierter Verein zur Förderung des Zu Fuß Gehens und für menschengerechten öffentlichen Raum.";
  readonly avatarUrl = "https://geht-doch.info/wp-content/uploads/2026/03/GD_logo_ohne_wien.png";
  readonly defaultEventImageUrl = "https://geht-doch.info/wp-content/uploads/2026/04/20170916-Streetlife-Festival_Christian-Fuerthner-45.jpg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const end = new Date(start);
    end.setMonth(end.getMonth() + 24);

    const queryUrl = `${API_URL}?status=publish&per_page=100&start_date=${encodeURIComponent(toTribeDate(start))}&end_date=${encodeURIComponent(toTribeDate(end))}`;
    const tribeEvents = await fetchTribeEvents(queryUrl);

    const events: Partial<EveryCalEvent>[] = [];
    for (const raw of tribeEvents) {
      const event = fromTribeEvent(raw, "geht-doch");
      if (!event.title || !event.startDate) continue;

      const location = raw.venue
        ? {
            name: raw.venue.venue?.trim() || "Wien",
            address: [raw.venue.address, raw.venue.zip, raw.venue.city].filter(Boolean).join(", ") || undefined,
          }
        : { name: "Wien", address: "Wien, Austria" };

      const categoryTags = (raw.categories || [])
        .map((c) => normalizeCategoryTag(c.name))
        .filter((c): c is string => Boolean(c));

      const tags = Array.from(new Set(["wien", "zu-fuß-gehen", "öffentlicher-raum", "wirmachenwien", ...categoryTags]));

      events.push({
        ...event,
        title: event.title.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
        description: event.description
          ? event.description.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
          : undefined,
        location,
        organizer: "GEHT-DOCH",
        tags,
      });
    }

    return events;
  }
}
