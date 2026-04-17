/**
 * Scraper for Flex Vienna (flex.at).
 *
 * Flex uses The Events Calendar (Tribe) WP plugin.
 * We consume its public REST API directly.
 */

import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../scraper.js";
import { fetchTribeEvents, fromTribeEvent, toTribeDate } from "../lib/tribe.js";

export class FlexScraper implements Scraper {
  readonly id = "flex_at";
  readonly name = "Flex Vienna";
  readonly eventTimezone = "Europe/Vienna";
  readonly url = "https://flex.at/wp-json/tribe/events/v1/events";
  readonly avatarUrl = "https://flex.at/wp-content/uploads/2022/05/Flex-Logo-weiss.svg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const end = new Date(start);
    end.setMonth(end.getMonth() + 24);

    const queryUrl = `${this.url}?status=publish&per_page=100&start_date=${encodeURIComponent(toTribeDate(start))}&end_date=${encodeURIComponent(toTribeDate(end))}`;
    const tribeEvents = await fetchTribeEvents(queryUrl);

    const events: Partial<EveryCalEvent>[] = [];
    for (const raw of tribeEvents) {
      const event = fromTribeEvent(raw, "flex-at");
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

    return events;
  }
}
