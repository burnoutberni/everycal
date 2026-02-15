/**
 * Scraper for Critical Mass Vienna (criticalmass.at).
 *
 * Critical Mass Vienna posts monthly ride announcements as WordPress
 * blog posts under the "wien" category. We scrape the RSS feed.
 *
 * Note: criticalmass.at has a broken TLS certificate chain (missing
 * intermediate certs). We use undici with TLS verification relaxed
 * for this specific host.
 */

import * as cheerio from "cheerio";
import { Agent, fetch as undiciFetch } from "undici";
import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";

const RSS_URL = "https://www.criticalmass.at/category/wien/feed/";

const agent = new Agent({
  connect: { rejectUnauthorized: false },
});

export class CriticalMassViennaScraper implements Scraper {
  readonly id = "critical-mass-vienna";
  readonly name = "Critical Mass Vienna";
  readonly url = RSS_URL;
  readonly website = "https://www.criticalmass.at/category/wien/";
  readonly bio = "Die Critical Mass Vienna rollt seit 2006 für klimafreundlichen Verkehr durch Wien: #MehrPlatzFürsRad";
  readonly avatarUrl = "https://wirmachen.wien/wp-content/uploads/2023/09/CM_tallbike_sunset.jpg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await undiciFetch(this.url, { dispatcher: agent });
    if (!response.ok) {
      throw new Error(`Failed to fetch Critical Mass RSS: ${response.status}`);
    }

    const xml = await response.text();
    const $ = cheerio.load(xml, { xml: true });
    const events: Partial<EveryCalEvent>[] = [];

    $("item").each((_i, item) => {
      const $item = $(item);
      const title = $item.find("title").text().trim();
      const link = $item.find("link").text().trim();
      const pubDate = $item.find("pubDate").text().trim();
      const description = $item.find("description").text().trim();

      if (!title) return;

      events.push({
        id: `cm-vienna-${link.replace(/[^a-z0-9]/gi, "-")}`,
        title,
        description,
        startDate: pubDate ? new Date(pubDate).toISOString() : undefined,
        url: link || undefined,
        location: {
          name: "Schwarzenbergplatz",
          address: "Schwarzenbergplatz 8, 1030 Wien",
          latitude: 48.1988,
          longitude: 16.3726,
          url: "https://www.criticalmass.at",
        },
        organizer: "Critical Mass Vienna",
        tags: ["vienna", "cycling", "critical-mass", "wirmachen-wien"],
        visibility: "public",
      });
    });

    return events;
  }
}
