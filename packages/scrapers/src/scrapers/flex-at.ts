/**
 * Scraper for Flex Vienna (flex.at).
 *
 * Flex uses The Events Calendar (Tribe) WP plugin which exposes an iCal feed.
 * We consume that directly — no HTML scraping needed.
 */

import { fromICal, type EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../scraper.js";

export class FlexScraper implements Scraper {
  readonly id = "flex_at";
  readonly name = "Flex Vienna";
  readonly url = "https://flex.at/events/?ical=1";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Flex iCal feed: ${response.status}`);
    }

    const text = await response.text();
    const events: Partial<EveryCalEvent>[] = [];

    // Split into individual VEVENT blocks
    const veventBlocks = text.split("BEGIN:VEVENT");
    for (const block of veventBlocks) {
      if (!block.includes("END:VEVENT")) continue;
      const vevent = "BEGIN:VEVENT" + block.split("END:VEVENT")[0] + "END:VEVENT";
      const event = fromICal(vevent);

      // Extract ATTACH as image (Tribe puts poster images there)
      const attachMatch = vevent.match(/ATTACH;FMTTYPE=([^:]+):(.+)/);
      if (attachMatch) {
        event.image = {
          url: attachMatch[2].trim(),
          mediaType: attachMatch[1].trim(),
        };
      }

      // Always tag with source location
      event.location = {
        name: "Flex",
        address: "Donaukanal / Augartenbrücke, 1010 Wien",
        latitude: 48.2177763,
        longitude: 16.370909,
        url: "https://flex.at",
      };

      event.tags = event.tags || [];
      event.tags.push("wien", "music");

      events.push(event);
    }

    return events;
  }
}
