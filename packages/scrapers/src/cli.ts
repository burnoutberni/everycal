#!/usr/bin/env node
/**
 * EveryCal Scraper CLI
 *
 * Usage:
 *   everycal-scrape                     # run all scrapers, print JSON
 *   everycal-scrape flex-at             # run a specific scraper
 *   everycal-scrape --list              # list available scrapers
 *   everycal-scrape flex-at --push URL  # scrape and POST to an EveryCal server
 */

import { registry, getScraperById } from "./registry.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list") || args.includes("-l")) {
    console.log("Available scrapers:\n");
    for (const s of registry) {
      console.log(`  ${s.id.padEnd(20)} ${s.name} (${s.url})`);
    }
    return;
  }

  const pushIdx = args.indexOf("--push");
  const pushUrl = pushIdx >= 0 ? args[pushIdx + 1] : undefined;
  const scraperIds = args.filter((a) => !a.startsWith("--") && a !== pushUrl);

  const scrapers = scraperIds.length > 0
    ? scraperIds.map((id) => {
        const s = getScraperById(id);
        if (!s) {
          console.error(`Unknown scraper: ${id}`);
          console.error(`Run with --list to see available scrapers.`);
          process.exit(1);
        }
        return s;
      })
    : registry;

  for (const scraper of scrapers) {
    console.error(`🔍 Scraping ${scraper.name} (${scraper.url})...`);
    try {
      const events = await scraper.scrape();
      console.error(`   Found ${events.length} events.`);

      if (pushUrl) {
        console.error(`   Pushing to ${pushUrl}...`);
        const res = await fetch(`${pushUrl}/api/v1/events/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: scraper.id, events }),
        });
        if (!res.ok) {
          console.error(`   ❌ Push failed: ${res.status} ${await res.text()}`);
        } else {
          console.error(`   ✅ Pushed successfully.`);
        }
      } else {
        // Print events as JSON to stdout (one object per scraper)
        console.log(JSON.stringify({ source: scraper.id, events }, null, 2));
      }
    } catch (err) {
      console.error(`   ❌ Error: ${err}`);
    }
  }
}

main();
