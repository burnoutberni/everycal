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

  /** Fetch and parse events from the source. */
  scrape(): Promise<Partial<EveryCalEvent>[]>;
}
