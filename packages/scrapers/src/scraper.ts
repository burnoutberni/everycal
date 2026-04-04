/**
 * Scraper interface — each venue/site scraper implements this.
 */

import type { EveryCalEvent } from "@everycal/core";

export interface Scraper {
  /** Unique slug for this scraper, e.g. "flex-at" */
  readonly id: string;

  /** Human-readable name, e.g. "Flex Vienna" */
  readonly name: string;

  /** The source URL being scraped */
  readonly url: string;

  /** The organisation's main website (used for the profile link) */
  readonly website?: string;

  /** Short bio / description of the organisation (used for the profile) */
  readonly bio?: string;

  /** URL of the organisation's logo / profile image */
  readonly avatarUrl?: string;

  /** Default event image URL used when a scraped event has no image. */
  readonly defaultEventImageUrl?: string;

  /** Declared IANA timezone used for naive/local source datetimes. */
  readonly eventTimezone: string;

  /** Fetch and parse events from the source. */
  scrape(): Promise<Partial<EveryCalEvent>[]>;
}
