#!/usr/bin/env node
/**
 * Production scraper runner — run all scrapers, sync to server, exit.
 *
 * Reads configuration from environment variables:
 *   JOBS_API_SERVER        — API base URL (required when scrapers run)
 *   SCRAPER_API_KEYS_FILE  — path to JSON file mapping scraper id → API key
 *   SCRAPER_API_KEYS_JSON  — inline JSON (alternative to file, e.g. for Docker secrets)
 *   SCRAPE_CONCURRENCY     — max concurrent scrape requests (default: 6)
 *
 * At least one of SCRAPER_API_KEYS_FILE or SCRAPER_API_KEYS_JSON is required.
 * If neither is set, exits 0 without syncing (reminders and other jobs still work).
 *
 * Exits 0 on success (even if individual scrapers fail), 1 on fatal config error.
 */

import { readFileSync } from "node:fs";
import { registry } from "./registry.js";
import type { Scraper } from "./scraper.js";
import type { EveryCalEvent } from "@everycal/core";
import { buildSyncPayload } from "./lib/build-sync-payload.js";

const CONCURRENCY = parseInt(process.env.SCRAPE_CONCURRENCY || "6", 10);

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val?.trim()) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val.trim();
}

/** Load API keys from SCRAPER_API_KEYS_FILE or SCRAPER_API_KEYS_JSON. */
function loadApiKeys(): Record<string, string> | null {
  const jsonEnv = process.env.SCRAPER_API_KEYS_JSON?.trim();
  if (jsonEnv) {
    try {
      return JSON.parse(jsonEnv) as Record<string, string>;
    } catch {
      console.error(`❌ SCRAPER_API_KEYS_JSON is not valid JSON`);
      process.exit(1);
    }
  }

  const filePath = process.env.SCRAPER_API_KEYS_FILE;
  if (!filePath) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8").trim();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      console.error(`❌ SCRAPER_API_KEYS_FILE (${filePath}) not found`);
      process.exit(1);
    }
    console.error(`❌ Cannot read SCRAPER_API_KEYS_FILE (${filePath}): ${err}`);
    process.exit(1);
  }

  try {
    return JSON.parse(raw) as Record<string, string>;
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

/** Update scraper account profile from scraper metadata (displayName, bio, website, avatarUrl). */
async function updateProfile(
  server: string,
  apiKey: string,
  scraper: Scraper,
): Promise<void> {
  const body: { displayName?: string; bio?: string; website?: string; avatarUrl?: string } = {
    displayName: scraper.name,
  };
  if (scraper.bio) body.bio = scraper.bio;
  if (scraper.website) body.website = scraper.website;
  if (scraper.avatarUrl) body.avatarUrl = scraper.avatarUrl;

  const res = await fetch(`${server}/api/v1/auth/me`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`profile update failed: ${res.status} ${text}`);
  }
}

async function main() {
  const apiKeys = loadApiKeys();

  if (!apiKeys) {
    console.log("⏭️  Scrapers skipped: no SCRAPER_API_KEYS_FILE or SCRAPER_API_KEYS_JSON configured");
    return;
  }

  const server = requireEnv("JOBS_API_SERVER");

  // Only run scrapers that have API keys configured
  const scrapers = registry.filter((s) => apiKeys[s.id]);
  const skipped = registry.filter((s) => !apiKeys[s.id]);

  if (scrapers.length === 0) {
    console.log("⏭️  Scrapers skipped: no matching API keys in config");
    return;
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

  // Phase 2: Sync to server sequentially (profile update + event sync)
  let syncErrors = 0;
  for (const { scraper, events, error } of results) {
    process.stdout.write(`   ${scraper.name.padEnd(30)}`);

    // Update profile from scraper metadata (overwrites setup placeholders).
    // Non-blocking: failures are logged but don't prevent event sync.
    try {
      await updateProfile(server, apiKeys[scraper.id], scraper);
    } catch (err) {
      console.log(`⚠️ profile: ${err instanceof Error ? err.message : err} (continuing with sync)`);
    }

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
        const r = (await res.json()) as {
          created: number; updated: number; unchanged: number; deleted: number; canceled?: number; rotatedOutPast?: number;
        };
        console.log(`✅ +${r.created} ~${r.updated} =${r.unchanged} !${r.canceled || 0} ↺${r.rotatedOutPast || 0}`);
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
