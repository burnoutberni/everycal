/**
 * Scraper for Westbahnpark Jetzt (westbahnpark.live).
 *
 * Initiative for a park on the Westbahnhof railway area.
 * Webflow CMS site with a /kalender page. Events are in
 * `.kalender-list-item` elements with hidden `.event-start`
 * and `.event-end` fields containing parseable dates.
 */

import * as cheerio from "cheerio";
import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";

const BASE_URL = "https://www.westbahnpark.live";
const CALENDAR_URL = `${BASE_URL}/kalender`;

export class WestbahnparkScraper implements Scraper {
  readonly id = "westbahnpark";
  readonly name = "Westbahnpark Jetzt";
  readonly url = CALENDAR_URL;
  readonly website = BASE_URL;
  readonly bio = "Wir unterstützen die Stadt, ihre selbstgesteckten Ziele zu erreichen – RAUS AUS DEM ASPHALT!";
  readonly avatarUrl = "https://wirmachen.wien/wp-content/uploads/2023/10/HL_2023_Westbahnhof_Export-Quer_0-26-scaled.jpg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await fetch(CALENDAR_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Westbahnpark calendar: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const events: Partial<EveryCalEvent>[] = [];
    const seenIds = new Set<string>();
    $(".kalender-list-item").each((_i, el) => {
      const $el = $(el);

      const title = $el.find(".event-title").first().text().trim();
      const startText = $el.find(".event-start").first().text().trim();
      const endText = $el.find(".event-end").first().text().trim();
      const description = $el.find(".event-desc").first().text().replace(/\s+/g, " ").trim();
      const link = $el.find("a").first().attr("href");

      // Location from .event-location
      const locationText = $el.find(".event-location").first().text().replace(/\s+/g, " ").trim();

      if (!title || !startText) return;

      const startDate = new Date(startText);
      const endDate = endText ? new Date(endText) : undefined;

      // Image from the event item
      const imgSrc = $el.find("img").first().attr("src");

      const fullUrl = link
        ? (link.startsWith("http") ? link : `${BASE_URL}${link}`)
        : CALENDAR_URL;

      // Build a unique ID; append a suffix if there are collisions
      let baseId = `westbahnpark-${startDate.toISOString()}-${title.slice(0, 40).replace(/[^a-z0-9]/gi, "-")}`;
      let eventId = baseId;
      let suffix = 2;
      while (seenIds.has(eventId)) {
        eventId = `${baseId}-${suffix++}`;
      }
      seenIds.add(eventId);

      events.push({
        id: eventId,
        title,
        description: description || undefined,
        startDate: startDate.toISOString(),
        endDate: endDate?.toISOString(),
        url: fullUrl,
        image: imgSrc ? { url: imgSrc } : undefined,
        location: locationText
          ? { name: locationText, url: BASE_URL }
          : { name: "Westbahnpark", address: "Westbahnhof-Areal, 1150 Wien", latitude: 48.1964, longitude: 16.3387, url: BASE_URL },
        organizer: "Westbahnpark Jetzt",
        tags: ["wien", "park", "bürgerinnen-initiative", "westbahnpark", "rudolfsheim-fünfhaus", "wirmachenwien"],
        visibility: "public",
      });
    });

    return events;
  }
}
