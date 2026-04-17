/**
 * Scraper registry — central list of all available scrapers.
 */

import type { Scraper } from "./scraper.js";
import { FlexScraper } from "./scrapers/flex-at.js";

// wirmachen.wien scrapers (7 organisations)
import {
  CriticalMassViennaScraper,
  RadlobbyWienScraper,
  MatznerViertelScraper,
  SpaceAndPlaceScraper,
  KirchberggasseScraper,
  WestbahnparkScraper,
  GehtDochScraper,
} from "./scrapers/wirmachenwien/index.js";

export const registry: Scraper[] = [
  // Existing scrapers
  new FlexScraper(),
  // new VotivkinoScraper(), // disabled — too many events for now

  // wirmachen.wien — orgs with dedicated event sources
  new CriticalMassViennaScraper(),
  new RadlobbyWienScraper(),
  new MatznerViertelScraper(),
  new SpaceAndPlaceScraper(),
  new KirchberggasseScraper(),
  new WestbahnparkScraper(),
  new GehtDochScraper(),
];

export function getScraperById(id: string): Scraper | undefined {
  return registry.find((s) => s.id === id);
}
