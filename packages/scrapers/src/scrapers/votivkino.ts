/**
 * Scraper for Votivkino / Kino De France (votivkino.at).
 *
 * The program page is a server-rendered HTML table with each film as a row
 * and each day as a column. Each screening is a link containing a <time>
 * element with an ISO datetime, plus location/room info.
 */

import * as cheerio from "cheerio";
import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../scraper.js";

const VENUES: Record<string, { name: string; address: string; lat: number; lng: number }> = {
  kino_votiv: {
    name: "Votiv Kino",
    address: "Währinger Straße 12, 1090 Wien",
    lat: 48.2168,
    lng: 16.3601,
  },
  kino_defrance: {
    name: "Kino De France",
    address: "Heßgasse 7 / Ecke Schottenring 5, 1010 Wien",
    lat: 48.2146,
    lng: 16.3632,
  },
};

export class VotivkinoScraper implements Scraper {
  readonly id = "votivkino";
  readonly name = "Votiv Kino & De France";
  readonly url = "https://www.votivkino.at/programm/";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch Votivkino program: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const events: Partial<EveryCalEvent>[] = [];

    // Each film is a <tr class="week-film-row">
    $("tr.week-film-row").each((_i, row) => {
      const $row = $(row);

      // Film info from the header cell
      const $titleLink = $row.find("th.week-film-title a.week-film-title-link");
      const title = $titleLink.find(".eventtitle").text().trim();
      const director = $titleLink.find(".eventregie").text().trim();
      const filmUrl = $titleLink.attr("href") || undefined;
      const yearText = $titleLink.find(".eventyear").text().trim();
      const lengthText = $titleLink.find(".eventlength .fs0").text().trim();

      if (!title) return;

      const description = [
        director ? `Regie: ${director}` : "",
        yearText ? `(${yearText})` : "",
        lengthText || "",
      ]
        .filter(Boolean)
        .join(" · ");

      // Each screening is an <a> with class week-show-item inside td cells
      $row.find("a.week-show-item").each((_j, showEl) => {
        const $show = $(showEl);
        const $time = $show.find("time");
        const datetime = $time.attr("datetime");
        if (!datetime) return;

        // Determine venue from class (kino_votiv or kino_defrance)
        const classes = $show.attr("class") || "";
        const venueKey = classes.includes("kino_defrance") ? "kino_defrance" : "kino_votiv";
        const venue = VENUES[venueKey];

        // Room/format info
        const locationSpan = $show.find(".location .blo").text().trim();
        const roomMatch = locationSpan.match(/\|\s*(.+)/);
        const room = roomMatch ? roomMatch[1].trim() : "";

        // Category (e.g. "Premiere", "Valentinstag", "Matinee")
        const category = $show.find(".category").text().trim();

        // Compute end time from film length
        let endDate: string | undefined;
        const durationMatch = lengthText.match(/(\d+)\s*min/);
        if (durationMatch) {
          const startMs = new Date(datetime).getTime();
          endDate = new Date(startMs + parseInt(durationMatch[1], 10) * 60 * 1000).toISOString();
        }

        const tags = ["wien", "cinema"];
        if (category) tags.push(category.toLowerCase());

        const showId = $show.attr("href")?.match(/show=(\d+)/)?.[1];

        events.push({
          id: showId ? `votivkino-${showId}` : `votivkino-${title}-${datetime}`,
          title,
          description: [description, room ? `Saal: ${room}` : ""].filter(Boolean).join(" — "),
          startDate: datetime,
          endDate,
          location: {
            name: `${venue.name}${room ? ` (${room})` : ""}`,
            address: venue.address,
            latitude: venue.lat,
            longitude: venue.lng,
            url: "https://www.votivkino.at",
          },
          url: filmUrl
            ? filmUrl.startsWith("http")
              ? filmUrl
              : `https://www.votivkino.at${filmUrl.startsWith("/") ? "" : "/"}${filmUrl}`
            : undefined,
          tags,
          visibility: "public",
        });
      });
    });

    return events;
  }
}
