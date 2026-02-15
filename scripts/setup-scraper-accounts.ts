#!/usr/bin/env node
/**
 * One-time setup: create passwordless scraper accounts and generate API keys.
 *
 * Each scraper gets its own account on the server with NO password — only
 * API-key authentication is possible, so there is no password to leak or brute-force.
 *
 * Usage:
 *   npx tsx scripts/setup-scraper-accounts.ts [server-url]
 *
 * The script prints:
 *   1. The SCRAPER_API_KEYS JSON blob to store as a secret
 *   2. A ready-to-use `docker run` command for the cron job
 *   3. A one-liner to run immediately for the initial sync
 *
 * If an account already exists (409), it is skipped — run this script only
 * once per server.  To rotate keys, delete the old ones via the API and re-run.
 */

import { registry } from "../packages/scrapers/src/registry.js";

const SERVER = process.argv.slice(2).find((a) => !a.startsWith("--")) || "http://localhost:3000";

async function main() {
  console.log(`\n🗓️  EveryCal Scraper Account Setup`);
  console.log(`   Server: ${SERVER}\n`);

  const apiKeys: Record<string, string> = {};
  const errors: string[] = [];

  for (const scraper of registry) {
    process.stdout.write(`  ${scraper.id.padEnd(30)}`);

    // Register without a password — the session from registration is used
    // solely to create an API key, then it expires and only the key remains.
    const regRes = await fetch(`${SERVER}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: scraper.id,
        displayName: scraper.name,
      }),
    });

    if (!regRes.ok) {
      if (regRes.status === 409) {
        console.log(`SKIP (already exists)`);
        errors.push(`${scraper.id}: already exists — delete and re-run to rotate keys`);
        continue;
      }
      const body = await regRes.text();
      console.log(`❌ register failed: ${regRes.status} ${body}`);
      errors.push(`${scraper.id}: register failed`);
      continue;
    }

    const regJson = (await regRes.json()) as { user: { id: string } };

    // Extract session cookie from Set-Cookie header for subsequent requests
    const setCookie = regRes.headers.get("set-cookie") || "";
    const sessionCookie = setCookie.match(/everycal_session=[^\s;]+/)?.[0];
    if (!sessionCookie) {
      console.log(`❌ no session cookie returned`);
      errors.push(`${scraper.id}: no session cookie`);
      continue;
    }

    // Set profile: bot flag, discoverable, bio, website, avatar
    const profileUpdate: Record<string, unknown> = { isBot: true, discoverable: true };
    if (scraper.bio) profileUpdate.bio = scraper.bio;
    if (scraper.website) profileUpdate.website = scraper.website;
    if (scraper.avatarUrl) profileUpdate.avatarUrl = scraper.avatarUrl;

    await fetch(`${SERVER}/api/v1/auth/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify(profileUpdate),
    });

    // Create API key — this is the ONLY auth mechanism for this account
    const keyRes = await fetch(`${SERVER}/api/v1/auth/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ label: "scraper" }),
    });

    if (!keyRes.ok) {
      console.log(`❌ API key creation failed`);
      errors.push(`${scraper.id}: API key creation failed`);
      continue;
    }

    const { key } = (await keyRes.json()) as { key: string };
    apiKeys[scraper.id] = key;
    console.log(`✅ created`);
  }

  const count = Object.keys(apiKeys).length;
  if (count === 0) {
    console.log(`\n❌ No accounts were created. Nothing to configure.`);
    if (errors.length > 0) {
      console.log(`\nIssues:`);
      for (const e of errors) console.log(`  - ${e}`);
    }
    process.exit(1);
  }

  // Write keys to file
  const outPath = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : "scraper-api-keys.json";

  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(apiKeys, null, 2) + "\n", "utf-8");
  try { chmodSync(outPath, 0o600); } catch { /* Windows */ }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${count} scraper account(s) created`);
  console.log(`${"═".repeat(70)}`);

  console.log(`\n🔑 API keys written to: ${outPath}  (mode 600, owner-read only)`);
  console.log(`   Move this file to your server, e.g. /opt/everycal/scraper-api-keys.json`);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`\n🔨 Build the scraper image:\n`);
  console.log(`  docker build -f Dockerfile.scrapers -t everycal-scrapers .`);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`\n🐳 Docker — run the scraper container once right now:\n`);
  console.log(`  docker run --rm \\`);
  console.log(`    -e EVERYCAL_SERVER=${SERVER} \\`);
  console.log(`    -e SCRAPER_API_KEYS_FILE=/secrets/scraper-api-keys.json \\`);
  console.log(`    -v $(pwd)/${outPath}:/secrets/scraper-api-keys.json:ro \\`);
  console.log(`    everycal-scrapers`);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`\n🕐 Cron — run daily at a random minute between 2:00–2:59 AM:\n`);
  const minute = Math.floor(Math.random() * 60);
  console.log(`  ${minute} 2 * * * docker run --rm \\`);
  console.log(`    -e EVERYCAL_SERVER=${SERVER} \\`);
  console.log(`    -e SCRAPER_API_KEYS_FILE=/secrets/scraper-api-keys.json \\`);
  console.log(`    -v /opt/everycal/scraper-api-keys.json:/secrets/scraper-api-keys.json:ro \\`);
  console.log(`    everycal-scrapers`);

  if (errors.length > 0) {
    console.log(`\n⚠️  Issues:`);
    for (const e of errors) console.log(`  - ${e}`);
  }

  console.log();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
