#!/usr/bin/env node
/**
 * Create a "wirmachen.wien" umbrella account that auto-reposts all
 * wirmachen.wien organisation scraper accounts.
 *
 * Usage:
 *   npx tsx scripts/setup-wirmachen-wien.ts [server-url] [--password=secret]
 *
 * The scraper accounts must already exist (run setup-scraper-accounts.ts first).
 * If the account doesn't exist, a random password is generated and saved to
 * .wirmachen-wien-password (printed to stdout once, then saved securely).
 *
 * If the account already exists, provide --password to authenticate.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const SERVER = args.find((a) => !a.startsWith("--")) || "http://localhost:3000";
const PASSWORD_ARG = args.find((a) => a.startsWith("--password="))?.slice(11);

const USERNAME = "wirmachen_wien";
const DISPLAY_NAME = "Wir machen Wien";
const BIO = "Für eine klimagerechte, lebenswerte und partizipative Stadt Wien";
const WEBSITE = "https://wirmachen.wien";
const AVATAR_URL =
  "https://wirmachen.wien/wp-content/uploads/2023/09/WMW_favicon-300x300.png";
const PASSWORD_FILE = ".wirmachen_wien_password";

/** Scraper account usernames that belong to the wirmachen.wien network */
const ORG_USERNAMES = [
  "critical_mass_vienna",
  "kirchberggasse",
  "matznerviertel",
  "radlobby_wien",
  "space_and_place",
  "westbahnpark",
];

async function main() {
  console.log(`Setting up @${USERNAME} umbrella account on ${SERVER}\n`);

  let password = PASSWORD_ARG;
  let sessionCookie: string;
  let isNewAccount = false;

  // Try to login first (account might already exist)
  if (!password && existsSync(PASSWORD_FILE)) {
    password = readFileSync(PASSWORD_FILE, "utf8").trim();
    console.log(`  ℹ️  Found existing password in ${PASSWORD_FILE}`);
  }

  if (password) {
    // Attempt login
    const loginRes = await fetch(`${SERVER}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password }),
    });

    if (loginRes.ok) {
      const setCookie = loginRes.headers.get("set-cookie") || "";
      sessionCookie = setCookie.match(/everycal_session=[^\s;]+/)?.[0] || "";
      if (!sessionCookie) {
        console.error(`  ❌ Login succeeded but no session cookie returned`);
        process.exit(1);
      }
      console.log(`  ✅ Logged in as @${USERNAME}\n`);
    } else if (loginRes.status === 401) {
      console.error(`  ❌ Login failed: wrong password`);
      console.error(`  Delete ${PASSWORD_FILE} to reset or provide --password=<new>`);
      process.exit(1);
    } else {
      // Account doesn't exist, will register below
      password = undefined;
    }
  }

  // Register if login failed or no password was provided
  if (!sessionCookie!) {
    // Generate random password
    password = randomBytes(32).toString("base64url");
    isNewAccount = true;

    const regRes = await fetch(`${SERVER}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: USERNAME,
        password,
        displayName: DISPLAY_NAME,
      }),
    });

    if (!regRes.ok) {
      if (regRes.status === 409) {
        console.error(`  ❌ Account @${USERNAME} already exists but login failed.`);
        console.error(`  Provide correct password with --password=<secret>`);
      } else {
        const err = await regRes.text();
        console.error(`  ❌ Registration failed: ${err}`);
      }
      process.exit(1);
    }

    const setCookie = regRes.headers.get("set-cookie") || "";
    sessionCookie = setCookie.match(/everycal_session=[^\s;]+/)?.[0] || "";
    if (!sessionCookie) {
      console.error(`  ❌ No session cookie returned`);
      process.exit(1);
    }

    // Save password to file
    writeFileSync(PASSWORD_FILE, password, { mode: 0o600 });

    console.log(`  ✅ Registered @${USERNAME}`);
    console.log(`  🔑 Password: ${password}`);
    console.log(`  💾 Saved to ${PASSWORD_FILE} (keep this secure!)\n`);
  }

  const authHeaders = {
    "Content-Type": "application/json",
    Cookie: sessionCookie,
  };

  // Update profile (only if new account or if details might have changed)
  if (isNewAccount) {
    const profileRes = await fetch(`${SERVER}/api/v1/auth/me`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({
        displayName: DISPLAY_NAME,
        bio: BIO,
        website: WEBSITE,
        avatarUrl: AVATAR_URL,
        discoverable: true,
      }),
    });

    if (profileRes.ok) {
      console.log(`  ✅ Profile updated (bio, website, avatar)\n`);
    } else {
      console.log(`  ⚠️  Profile update: ${profileRes.status} ${await profileRes.text()}\n`);
    }
  }

  // Follow + auto-repost each org account
  console.log(`Setting up auto-reposts from wirmachen.wien org accounts:\n`);
  for (const org of ORG_USERNAMES) {
    // Follow
    const followRes = await fetch(`${SERVER}/api/v1/users/${org}/follow`, {
      method: "POST",
      headers: authHeaders,
    });

    // Auto-repost
    const repostRes = await fetch(`${SERVER}/api/v1/users/${org}/auto-repost`, {
      method: "POST",
      headers: authHeaders,
    });

    const followOk = followRes.ok || followRes.status === 409;
    const repostOk = repostRes.ok || repostRes.status === 409;

    if (followOk && repostOk) {
      console.log(`  ✅ @${org} — following + auto-repost enabled`);
    } else if (!followOk) {
      console.log(`  ❌ @${org} — follow failed: ${followRes.status} ${await followRes.text()}`);
    } else {
      console.log(`  ❌ @${org} — auto-repost failed: ${repostRes.status} ${await repostRes.text()}`);
    }
  }

  console.log(`\n✅ Done! @${USERNAME} now auto-reposts all events from ${ORG_USERNAMES.length} wirmachen.wien orgs.`);
  console.log(`   Visit ${SERVER}/@${USERNAME} to see the unified feed.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
