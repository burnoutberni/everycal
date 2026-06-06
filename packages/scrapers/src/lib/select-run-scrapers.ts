import type { Scraper } from "../scraper.js";

export function selectRunScrapers(options: {
  requestedScrapers: Scraper[] | null;
  registry: Scraper[];
  apiKeys: Record<string, string>;
}): Scraper[] {
  if (options.requestedScrapers) return options.requestedScrapers;
  return options.registry.filter((scraper) => options.apiKeys[scraper.id]);
}
