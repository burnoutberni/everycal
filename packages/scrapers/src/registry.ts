/**
 * Scraper registry — central list of all available scrapers.
 */

import type { Scraper } from "./scraper.js";
import { FlexScraper } from "./scrapers/flex-at.js";
import { VotivkinoScraper } from "./scrapers/votivkino.js";

export const registry: Scraper[] = [new FlexScraper(), new VotivkinoScraper()];

export function getScraperById(id: string): Scraper | undefined {
  return registry.find((s) => s.id === id);
}
