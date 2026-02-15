/**
 * Scraper for Radlobby Wien (radlobby.at/wien).
 *
 * Radlobby Wien is the Vienna chapter of the Austrian cycling lobby.
 * Their termine page embeds a public Google Calendar. We fetch the
 * iCal feed directly for reliable, structured event data.
 *
 * The various Radlobby district sub-groups (Floridsdorf, Hietzing,
 * Leopoldstadt-Brigittenau, Margareten, Ottakring, Simmering) all
 * post their events to this same calendar and are covered here.
 */

import { fromICal, type EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../../scraper.js";

const GOOGLE_CALENDAR_ID =
  "c_0b4df923643e01e2f1749af98ec7597f8f0fd90be5a8a98d68f0f8cb7ea14307@group.calendar.google.com";
const ICAL_URL = `https://calendar.google.com/calendar/ical/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/public/basic.ics`;

export class RadlobbyWienScraper implements Scraper {
  readonly id = "radlobby-wien";
  readonly name = "Radlobby Wien";
  readonly url = "https://www.radlobby.at/wien/termine";
  readonly website = "https://www.radlobby.at/wien";
  readonly bio = "Die Radlobby Wien vertritt die Interessen der heute und zukünftig Radfahrenden. Werde Teil davon!";
  readonly avatarUrl = "https://wirmachen.wien/wp-content/uploads/2023/10/RLW_Neubauguertel_Aktion_WmW.jpg";

  async scrape(): Promise<Partial<EveryCalEvent>[]> {
    const response = await fetch(ICAL_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Radlobby Wien calendar: ${response.status}`);
    }

    const text = await response.text();
    const events: Partial<EveryCalEvent>[] = [];

    // Split into individual VEVENT blocks
    const veventBlocks = text.split("BEGIN:VEVENT");
    for (const block of veventBlocks) {
      if (!block.includes("END:VEVENT")) continue;
      const vevent = "BEGIN:VEVENT" + block.split("END:VEVENT")[0] + "END:VEVENT";
      const event = fromICal(vevent);

      if (!event.title || !event.startDate) continue;

      // For recurring events, Google Calendar emits multiple VEVENTs with the
      // same UID but different RECURRENCE-ID values. Append the RECURRENCE-ID
      // (or the DTSTART) to the UID to make each instance unique.
      const recurrenceId = vevent.match(/RECURRENCE-ID[^:]*:(.+)/)?.[1]?.trim();
      const uid = event.id || event.title;
      const instanceKey = recurrenceId || event.startDate;
      event.id = `radlobby-wien-${uid}-${instanceKey}`.replace(/[^a-z0-9-]/gi, "-");

      event.tags = event.tags || [];
      event.tags.push("vienna", "cycling", "radlobby", "wirmachen-wien");
      event.organizer = "Radlobby Wien";
      event.visibility = "public";

      events.push(event);
    }

    return events;
  }
}
