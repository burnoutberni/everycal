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
 * When running multiple scrapers, sources are fetched concurrently (up to 6
 * at a time by default). Syncs to the server happen sequentially to avoid
 * overloading the database.
 */

import { registry, getScraperById } from "./registry.js";
import type { Scraper } from "./scraper.js";
import type { EveryCalEvent } from "@everycal/core";

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY || "6", 10);

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function buildSyncPayload(scraper: Scraper, events: Partial<EveryCalEvent>[]) {
  return events
    .filter((ev) => ev.title && ev.startDate)  // skip events missing required fields
    .map((ev) => ({
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
}

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

  // Phase 1: Scrape all sources concurrently
  const concurrency = scrapers.length === 1 ? 1 : CONCURRENCY;
  console.error(`🔍 Scraping ${scrapers.length} source(s) (concurrency: ${concurrency})…`);
  const start = Date.now();

  const results = await mapConcurrent(scrapers, concurrency, async (scraper) => {
    try {
      const events = await scraper.scrape();
      return { scraper, events, error: null as string | null };
    } catch (err) {
      return { scraper, events: [] as Partial<EveryCalEvent>[], error: String(err) };
    }
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const totalEvents = results.reduce((n, r) => n + r.events.length, 0);
  console.error(`   Done: ${totalEvents} events from ${results.length} sources in ${elapsed}s\n`);

  // Phase 2: Output or sync (sequential to avoid overloading the server DB)
  for (const { scraper, events, error } of results) {
    if (error) {
      console.error(`❌ ${scraper.name}: ${error}`);
      continue;
    }

    console.error(`   ${scraper.name}: ${events.length} events`);

    if (syncUrl && apiKey) {
      const syncEvents = buildSyncPayload(scraper, events);

      if (dryRun) {
        console.error(`   [DRY RUN] Would sync ${syncEvents.length} events to ${syncUrl}`);
        console.log(JSON.stringify({ source: scraper.id, events: syncEvents }, null, 2));
        continue;
      }

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
          `   ✅ Synced: ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`
        );
      }
    } else {
      console.log(JSON.stringify({ source: scraper.id, events }, null, 2));
    }
  }
}

main();
