#!/usr/bin/env node
/**
 * Register scraper accounts on an EveryCal server.
 *
 * Usage:
 *   npx tsx scripts/setup-scrapers.ts [server-url]
 *
 * This creates one account per scraper and prints the API keys.
 * Run this once when setting up a new server.
 */

import { registry } from "../packages/scrapers/src/registry.js";

const SERVER = process.argv[2] || "http://localhost:3000";
const PASSWORD = process.env.SCRAPER_PASSWORD || "scraper-" + Math.random().toString(36).slice(2, 14);

async function main() {
  console.log(`Setting up scraper accounts on ${SERVER}\n`);
  console.log(`Generated password: ${PASSWORD}\n`);

  const results: { id: string; username: string; apiKey: string }[] = [];

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
    results.push({ id: scraper.id, username: scraper.id, apiKey: key });
  }

  if (results.length > 0) {
    console.log("\n--- Scraper commands ---\n");
    for (const r of results) {
      console.log(
        `everycal-scrape ${r.username} --sync ${SERVER} --api-key ${r.apiKey}`
      );
    }

    console.log("\n--- Or run all at once ---\n");
    console.log("# Add to crontab or systemd timer:");
    for (const r of results) {
      console.log(
        `everycal-scrape ${r.username} --sync ${SERVER} --api-key ${r.apiKey}`
      );
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
