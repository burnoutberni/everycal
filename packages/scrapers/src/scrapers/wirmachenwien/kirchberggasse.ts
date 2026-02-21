/**
 * Scraper for Initiative Kirchberggasse (kirchberggasse.at).
 *
 * A neighbourhood initiative in Vienna's 7th district.
 * WordPress site with blog posts about events.
 */

import * as cheerio from "cheerio";
import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";

const BASE_URL = "https://kirchberggasse.at";
const FEED_URL = "https://kirchberggasse.at/feed/";

export class KirchberggasseScraper implements Scraper {
  readonly id = "kirchberggasse";
  readonly name = "Initiative Kirchberggasse";
  readonly url = BASE_URL;
  readonly website = "https://kirchberggasse.at";
  readonly bio = "Die Kirchberggasse zur Wohnstraße machen: begrünt, verkehrsberuhigt und gemeinsam gestaltet!";
  readonly avatarUrl = "https://wirmachen.wien/wp-content/uploads/2023/10/kirchberggasse_fest.jpg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    // Try RSS feed first
    try {
      const response = await fetch(FEED_URL);
      if (response.ok) {
        const xml = await response.text();
        if (xml.includes("<rss") || xml.includes("<feed")) {
          return this.parseRSS(xml);
        }
      }
    } catch {
      // Fall through to HTML scraping
    }

    // Fallback: scrape main page
    const response = await fetch(BASE_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Kirchberggasse: ${response.status}`);
    }

    const html = await response.text();
    return this.parseHTML(html);
  }

  private parseRSS(xml: string): Partial<EveryCalEvent>[] {
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
        id: `kirchberggasse-${link.replace(/[^a-z0-9]/gi, "-")}`,
        title,
        description: description.slice(0, 500),
        startDate: pubDate ? new Date(pubDate).toISOString() : undefined,
        url: link || undefined,
        location: {
          name: "Kirchberggasse, 1070 Wien",
          address: "Kirchberggasse, 1070 Wien",
          url: BASE_URL,
        },
        organizer: "Initiative Kirchberggasse",
        tags: ["wien", "bürgerinnen-initiative", "neubau", "wirmachenwien"],
        visibility: "public",
      });
    });

    return events;
  }

  private parseHTML(html: string): Partial<EveryCalEvent>[] {
    const $ = cheerio.load(html);
    const events: Partial<EveryCalEvent>[] = [];

    $("article, .post, .entry").each((_i, el) => {
      const $el = $(el);
      const title = $el.find(".entry-title a, h2 a").first().text().trim();
      const link = $el.find(".entry-title a, h2 a").first().attr("href");
      const dateText = $el.find("time").attr("datetime");

      if (!title) return;

      events.push({
        id: `kirchberggasse-${link?.replace(/[^a-z0-9]/gi, "-") || title.replace(/[^a-z0-9]/gi, "-")}`,
        title,
        startDate: dateText ? new Date(dateText).toISOString() : undefined,
        url: link || undefined,
        location: {
          name: "Kirchberggasse, 1070 Wien",
          address: "Kirchberggasse, 1070 Wien",
          url: BASE_URL,
        },
        organizer: "Initiative Kirchberggasse",
        tags: ["wien", "bürgerinnen-initiative", "kirchberggasse", "wirmachenwien"],
        visibility: "public",
      });
    });

    return events;
  }
}
