#!/usr/bin/env node
/**
 * Production scraper runner — run all scrapers, sync to server, exit.
 *
 * Reads configuration from environment variables:
 *   EVERYCAL_SERVER        — server URL (required)
 *   SCRAPER_API_KEYS_FILE  — path to JSON file mapping scraper id → API key (required)
 *   SCRAPE_CONCURRENCY     — max concurrent scrape requests (default: 6)
 *
 * Example:
 *   EVERYCAL_SERVER=https://cal.example.com \
 *   SCRAPER_API_KEYS_FILE=/run/secrets/scraper-api-keys.json \
 *   node packages/scrapers/dist/run.js
 *
 * Exits 0 on success (even if individual scrapers fail), 1 on fatal config error.
 */

import { readFileSync } from "node:fs";
import { registry } from "./registry.js";
import type { Scraper } from "./scraper.js";
import type { EveryCalEvent } from "@everycal/core";

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY || "6", 10);

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

/** Load API keys from the JSON file at SCRAPER_API_KEYS_FILE. */
function loadApiKeys(): Record<string, string> {
  const filePath = requireEnv("SCRAPER_API_KEYS_FILE");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8").trim();
  } catch (err) {
    console.error(`❌ Cannot read SCRAPER_API_KEYS_FILE (${filePath}): ${err}`);
    process.exit(1);
  }

  try {
    return JSON.parse(raw);
  } catch {
    console.error(`❌ ${filePath} is not valid JSON`);
    process.exit(1);
  }
}

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
    .filter((ev) => ev.title && ev.startDate)
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
  const server = requireEnv("EVERYCAL_SERVER");
  const apiKeys = loadApiKeys();

  // Only run scrapers that have API keys configured
  const scrapers = registry.filter((s) => apiKeys[s.id]);
  const skipped = registry.filter((s) => !apiKeys[s.id]);

  if (scrapers.length === 0) {
    console.error("❌ No scrapers have matching API keys. Check your SCRAPER_API_KEYS_FILE.");
    process.exit(1);
  }

  console.log(`🗓️  EveryCal Scraper Run — ${new Date().toISOString()}`);
  console.log(`   Server: ${server}`);
  console.log(`   Scrapers: ${scrapers.length} active, ${skipped.length} skipped\n`);

  // Phase 1: Scrape all sources concurrently
  const start = Date.now();
  console.log(`🔍 Scraping ${scrapers.length} source(s) (concurrency: ${CONCURRENCY})…`);

  const results = await mapConcurrent(scrapers, CONCURRENCY, async (scraper) => {
    try {
      const events = await scraper.scrape();
      return { scraper, events, error: null as string | null };
    } catch (err) {
      return { scraper, events: [] as Partial<EveryCalEvent>[], error: String(err) };
    }
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const totalEvents = results.reduce((n, r) => n + r.events.length, 0);
  const errors = results.filter((r) => r.error);
  console.log(`   ${totalEvents} events from ${results.length} sources in ${elapsed}s (${errors.length} errors)\n`);

  // Phase 2: Sync to server sequentially
  let syncErrors = 0;
  for (const { scraper, events, error } of results) {
    process.stdout.write(`   ${scraper.name.padEnd(30)}`);

    if (error) {
      console.log(`❌ scrape failed: ${error}`);
      syncErrors++;
      continue;
    }

    const syncEvents = buildSyncPayload(scraper, events);
    if (syncEvents.length === 0) {
      console.log(`0 events`);
      continue;
    }

    process.stdout.write(`${syncEvents.length} events → `);

    try {
      const res = await fetch(`${server}/api/v1/events/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${apiKeys[scraper.id]}`,
        },
        body: JSON.stringify({ events: syncEvents }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.log(`❌ ${res.status} ${body}`);
        syncErrors++;
      } else {
        const r = (await res.json()) as { created: number; updated: number; unchanged: number; deleted: number };
        console.log(`✅ +${r.created} ~${r.updated} =${r.unchanged} -${r.deleted}`);
      }
    } catch (err) {
      console.log(`❌ sync: ${err}`);
      syncErrors++;
    }
  }

  console.log(`\n✅ Done. ${syncErrors > 0 ? `${syncErrors} error(s).` : "All good."}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
