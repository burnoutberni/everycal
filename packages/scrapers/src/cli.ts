#!/usr/bin/env node
/**
 * EveryCal Scraper CLI
 *
 * Usage:
 *   everycal-scrape                                    # run all scrapers, print JSON
 *   everycal-scrape flex-at                            # run a specific scraper
 *   everycal-scrape --list                             # list available scrapers
 *   everycal-scrape flex-at --sync URL --api-key KEY   # scrape and sync to an EveryCal server
 *
 * Each scraper maps to one account on the server (scraper id = username).
 * The --sync flag does a full sync: creates new events, updates changed ones,
 * and removes events that are no longer in the scraped set.
 *
 * Setup:
 *   1. Register an account on the server with the scraper's id as username
 *      (e.g. "flex-at", "votivkino")
 *   2. Create an API key for that account
 *   3. Run: everycal-scrape flex-at --sync http://localhost:3000 --api-key ecal_...
 */

import { registry, getScraperById } from "./registry.js";
import type { EveryCalEvent } from "@everycal/core";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: everycal-scrape [scraper-id...] [options]

Options:
  --list, -l                List available scrapers
  --sync URL                Sync scraped events to an EveryCal server
  --api-key KEY             API key for authentication (required with --sync)
  --dry-run                 With --sync: show what would happen without making changes
  --help, -h                Show this help

Examples:
  everycal-scrape --list
  everycal-scrape flex-at
  everycal-scrape flex-at --sync http://localhost:3000 --api-key ecal_abc123
  everycal-scrape --sync http://localhost:3000 --api-key ecal_abc123`);
    return;
  }

  if (args.includes("--list") || args.includes("-l")) {
    console.log("Available scrapers:\n");
    for (const s of registry) {
      console.log(`  ${s.id.padEnd(20)} ${s.name} (${s.url})`);
    }
    console.log(`\nEach scraper's id is also its username on the server.`);
    return;
  }

  const syncIdx = args.indexOf("--sync");
  const syncUrl = syncIdx >= 0 ? args[syncIdx + 1] : undefined;
  const apiKeyIdx = args.indexOf("--api-key");
  const apiKey = apiKeyIdx >= 0 ? args[apiKeyIdx + 1] : undefined;
  const dryRun = args.includes("--dry-run");

  // Collect scraper IDs (positional args that aren't flags or flag values)
  const flagValues = new Set<string>();
  if (syncUrl) flagValues.add(syncUrl);
  if (apiKey) flagValues.add(apiKey);
  const scraperIds = args.filter(
    (a) => !a.startsWith("--") && !flagValues.has(a)
  );

  if (syncUrl && !apiKey) {
    console.error("Error: --api-key is required when using --sync");
    process.exit(1);
  }

  const scrapers =
    scraperIds.length > 0
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

      if (syncUrl && apiKey) {
        // Build sync payload — each event needs an externalId
        const syncEvents = events.map((ev) => ({
          externalId: ev.id || `${scraper.id}-${ev.title}-${ev.startDate}`,
          title: ev.title!,
          description: ev.description || undefined,
          startDate: ev.startDate!,
          endDate: ev.endDate || undefined,
          allDay: ev.allDay || false,
          location: ev.location || undefined,
          image: ev.image || undefined,
          url: ev.url || undefined,
          tags: ev.tags || undefined,
          visibility: ev.visibility || "public",
        }));

        if (dryRun) {
          console.error(`   [DRY RUN] Would sync ${syncEvents.length} events to ${syncUrl}`);
          console.log(JSON.stringify({ source: scraper.id, events: syncEvents }, null, 2));
          continue;
        }

        console.error(`   Syncing to ${syncUrl}...`);
        const res = await fetch(`${syncUrl}/api/v1/events/sync`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `ApiKey ${apiKey}`,
          },
          body: JSON.stringify({ events: syncEvents }),
        });

        if (!res.ok) {
          const errorBody = await res.text();
          console.error(`   ❌ Sync failed: ${res.status} ${errorBody}`);
        } else {
          const result = (await res.json()) as {
            created: number;
            updated: number;
            deleted: number;
            total: number;
          };
          console.error(
            `   ✅ Synced: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted (${result.total} total)`
          );
        }
      } else {
        // Print events as JSON to stdout
        console.log(JSON.stringify({ source: scraper.id, events }, null, 2));
      }
    } catch (err) {
      console.error(`   ❌ Error: ${err}`);
    }
  }
}

main();
