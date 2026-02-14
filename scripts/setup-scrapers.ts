#!/usr/bin/env node
/**
 * Register scraper accounts on an EveryCal server and optionally run them.
 *
 * Usage:
 *   npx tsx scripts/setup-scrapers.ts [server-url] [--run]
 *
 * Options:
 *   --run    After registering, immediately scrape all sources and sync events
 *
 * This creates one account per scraper, generates API keys, and prints
 * ready-to-use CLI commands. Run this once when setting up a new server.
 */

import { registry } from "../packages/scrapers/src/registry.js";

const args = process.argv.slice(2);
const runAfter = args.includes("--run");
const SERVER = args.find((a) => !a.startsWith("--")) || "http://localhost:3000";
const PASSWORD =
  process.env.SCRAPER_PASSWORD || "scraper-" + Math.random().toString(36).slice(2, 14);

async function main() {
  console.log(`Setting up scraper accounts on ${SERVER}\n`);
  console.log(`Generated password: ${PASSWORD}\n`);

  const results: { id: string; name: string; apiKey: string }[] = [];

  for (const scraper of registry) {
    process.stdout.write(`  ${scraper.id.padEnd(20)}`);

    // Register account
    const regRes = await fetch(`${SERVER}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: scraper.id,
        password: PASSWORD,
        displayName: scraper.name,
      }),
    });

    let token: string;
    if (regRes.ok) {
      const data = (await regRes.json()) as { token: string };
      token = data.token;
      process.stdout.write("registered → ");
    } else {
      const err = (await regRes.json()) as { error: string };
      if (regRes.status === 409) {
        // Already exists, login instead
        const loginRes = await fetch(`${SERVER}/api/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: scraper.id, password: PASSWORD }),
        });
        if (!loginRes.ok) {
          console.log(`SKIP (exists, login failed)`);
          continue;
        }
        const data = (await loginRes.json()) as { token: string };
        token = data.token;
        process.stdout.write("exists → ");
      } else {
        console.log(`ERROR: ${err.error}`);
        continue;
      }
    }

    // Create API key
    const keyRes = await fetch(`${SERVER}/api/v1/auth/api-keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ label: "scraper-cli" }),
    });

    if (!keyRes.ok) {
      console.log("ERROR creating API key");
      continue;
    }

    const { key } = (await keyRes.json()) as { key: string };
    console.log(`API key: ${key}`);
    results.push({ id: scraper.id, name: scraper.name, apiKey: key });
  }

  if (results.length === 0) {
    console.log("\nNo scrapers were set up.");
    return;
  }

  console.log("\n--- Scraper commands ---\n");
  for (const r of results) {
    console.log(
      `everycal-scrape ${r.id} --sync ${SERVER} --api-key ${r.apiKey}`
    );
  }

  if (!runAfter) {
    console.log("\nTip: add --run to scrape and sync all sources immediately.");
    return;
  }

  // Run each scraper and sync to the server
  console.log("\n--- Running scrapers ---\n");

  for (const r of results) {
    const scraper = registry.find((s) => s.id === r.id);
    if (!scraper) continue;

    process.stdout.write(`🔍 ${scraper.name} (${scraper.url})... `);

    try {
      const events = await scraper.scrape();
      process.stdout.write(`${events.length} events → `);

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

      const res = await fetch(`${SERVER}/api/v1/events/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `ApiKey ${r.apiKey}`,
        },
        body: JSON.stringify({ events: syncEvents }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.log(`❌ ${res.status} ${body}`);
      } else {
        const result = (await res.json()) as {
          created: number;
          updated: number;
          deleted: number;
          total: number;
        };
        console.log(
          `✅ ${result.created} created, ${result.updated} updated, ${result.deleted} deleted`
        );
      }
    } catch (err) {
      console.log(`❌ ${err}`);
    }
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
