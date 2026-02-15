#!/usr/bin/env node
/**
 * Create a "wirmachen.wien" umbrella account that auto-reposts all
 * wirmachen.wien organisation accounts.
 *
 * Usage:
 *   npx tsx scripts/setup-wirmachen-wien.ts [server-url]
 *
 * The scraper accounts must already exist (run setup-scraper-accounts.ts first).
 * This creates a passwordless account (API-key-only auth, like scrapers).
 */

const args = process.argv.slice(2);
const SERVER = args.find((a) => !a.startsWith("--")) || "http://localhost:3000";

const USERNAME = "wirmachen.wien";
const DISPLAY_NAME = "Wir machen Wien";
const BIO = "Für eine klimagerechte, lebenswerte und partizipative Stadt Wien";
const WEBSITE = "https://wirmachen.wien";
const AVATAR_URL =
  "https://wirmachen.wien/wp-content/uploads/2023/09/WMW_favicon-300x300.png";

/** Scraper account usernames that belong to the wirmachen.wien network */
const ORG_USERNAMES = [
  "critical-mass-vienna",
  "kirchberggasse",
  "matznerviertel",
  "radlobby-wien",
  "space-and-place",
  "westbahnpark",
];

async function main() {
  console.log(`Setting up ${USERNAME} on ${SERVER}\n`);

  // 1. Register (passwordless)
  const regRes = await fetch(`${SERVER}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: USERNAME,
      displayName: DISPLAY_NAME,
    }),
  });

  if (!regRes.ok) {
    if (regRes.status === 409) {
      console.log(`  ℹ️  @${USERNAME} already exists — nothing to do.`);
      console.log(`  To re-create, delete the account first.`);
      process.exit(0);
    }
    const err = await regRes.text();
    console.error(`  ❌ Registration failed: ${err}`);
    process.exit(1);
  }

  const regJson = (await regRes.json()) as { user: { id: string } };

  // Extract session cookie from Set-Cookie header
  const setCookie = regRes.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.match(/everycal_session=[^\s;]+/)?.[0];
  if (!sessionCookie) {
    console.error(`  ❌ No session cookie returned`);
    process.exit(1);
  }
  console.log(`  ✅ Registered @${USERNAME} (passwordless)`);

  const authHeaders = {
    "Content-Type": "application/json",
    Cookie: sessionCookie,
  };

  // 2. Update profile
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
    console.log(`  ✅ Profile updated (bio, website, avatar)`);
  } else {
    console.log(`  ⚠️  Profile update: ${profileRes.status} ${await profileRes.text()}`);
  }

  // 3. Follow + auto-repost each org account
  console.log();
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
      console.log(`  ✅ @${org} — following + auto-repost`);
    } else if (!followOk) {
      console.log(`  ❌ @${org} — follow failed: ${followRes.status} ${await followRes.text()}`);
    } else {
      console.log(`  ❌ @${org} — auto-repost failed: ${repostRes.status} ${await repostRes.text()}`);
    }
  }

  console.log(`\nDone! Visit ${SERVER}/@${USERNAME} to see the profile.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
