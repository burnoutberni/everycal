import type { EveryCalEvent } from "@everycal/core";
import type { Scraper } from "../scraper.js";
import { decodeHtmlEntitiesOnce } from "./text.js";

export function buildSyncPayload(scraper: Scraper, events: Partial<EveryCalEvent>[]) {
  return events
    .filter((ev) => ev.title && ev.startDate)
    .map((ev) => {
      const rawTitle = ev.title!;
      const title = decodeHtmlEntitiesOnce(rawTitle);
      const image = ev.image || (scraper.defaultEventImageUrl ? { url: scraper.defaultEventImageUrl } : undefined);
      const location = ev.location
        ? {
            ...ev.location,
            name: decodeHtmlEntitiesOnce(ev.location.name),
            address: ev.location.address ? decodeHtmlEntitiesOnce(ev.location.address) : undefined,
          }
        : undefined;
      const tags = ev.tags?.map((tag) => decodeHtmlEntitiesOnce(tag));

      return {
        externalId: ev.id || `${scraper.id}-${rawTitle}-${ev.startDate}`,
        title,
        description: ev.description || undefined,
        startDate: ev.startDate!,
        endDate: ev.endDate || undefined,
        eventTimezone: ev.eventTimezone || scraper.eventTimezone,
        allDay: ev.allDay || false,
        location,
        image,
        url: ev.url || undefined,
        tags,
        visibility: ev.visibility || "public",
      };
    });
}
