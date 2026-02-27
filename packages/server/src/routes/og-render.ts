/**
 * OG tag rendering routes for crawlers.
 *
 * These routes intercept crawler requests to /@username/slug and /@username
 * and return HTML with pre-rendered OG tags for social media sharing.
 *
 * Only handles crawler requests (via isCrawler). Falls through to SPA for
 * regular users.
 */

import { Hono } from "hono";
import type { DB } from "../db.js";
import { isCrawler } from "../lib/crawler.js";
import { renderOgHtml } from "../lib/og-html.js";

export function ogRenderRoutes(db: DB): Hono {
  const router = new Hono();

  // GET /@:username/:slug — Event OG rendering
  router.get("/@:username/:slug", async (c) => {
    const userAgent = c.req.header("user-agent");
    const username = c.req.param("username") as string;
    const slug = c.req.param("slug") as string;
    console.log(`[OG] Event request: /@${username}/${slug} UA: ${userAgent || "(none)"}`);

    // Only handle crawler requests
    if (!isCrawler(userAgent)) {
      return c.text("", 404);
    }

    // Fetch event - only public/unlisted events get OG tags
    const event = db.prepare(`
      SELECT e.*, a.username AS account_username, a.display_name AS account_display_name
      FROM events e
      JOIN accounts a ON a.id = e.account_id
      WHERE a.username = ? AND e.slug = ?
    `).get(username, slug) as {
      id: string;
      title: string;
      description: string | null;
      start_date: string;
      location_name: string | null;
      location_address: string | null;
      image_url: string | null;
      og_image_url: string | null;
      visibility: string;
    } | undefined;

    if (!event) {
      console.log(`[OG] Event not found: /@${username}/${slug}`);
      return c.text("", 404);
    }

    // Only render OG tags for public/unlisted events (don't leak private info)
    if (event.visibility !== "public" && event.visibility !== "unlisted") {
      console.log(`[OG] Event not public/unlisted: /@${username}/${slug} visibility=${event.visibility}`);
      return c.text("", 404);
    }

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    const eventUrl = `${baseUrl}/@${username}/${slug}`;

    // Determine image: prefer og_image_url, fall back to image_url
    const imageUrl = event.og_image_url || event.image_url;
    const fullImageUrl = imageUrl
      ? imageUrl.startsWith("http")
        ? imageUrl
        : `${baseUrl}${imageUrl}`
      : `${baseUrl}/og-image.png`;

    // Build description from event details
    const startDate = new Date(event.start_date).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    let description = startDate;
    if (event.location_name) {
      description += ` · ${event.location_name}`;
      if (event.location_address) {
        description += ` (${event.location_address})`;
      }
    }

    const tags = {
      title: `${event.title} — @${username}`,
      description,
      image: fullImageUrl,
      url: eventUrl,
      type: "article",
    };

    console.log(`[OG] Rendering event OG tags for: /@${username}/${slug}`);

    const html = await renderOgHtml(tags);
    return c.html(html);
  });

  // GET /@:username — Profile OG rendering
  router.get("/@:username", async (c) => {
    const userAgent = c.req.header("user-agent");
    console.log(`[OG] Profile request: /@${c.req.param("username")} UA: ${userAgent || "(none)"}`);

    // Only handle crawler requests
    if (!isCrawler(userAgent)) {
      return c.text("", 404);
    }

    const username = c.req.param("username") as string;
    if (!username) {
      return c.text("", 404);
    }

    // Check for remote profile (username@domain format)
    const atIdx = username.indexOf("@");
    if (atIdx > 0 && atIdx < username.length - 1) {
      // Remote profile - we don't have detailed info, return 404 to fall through
      console.log(`[OG] Remote profile not supported: /@${username}`);
      return c.text("", 404);
    }

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";

    // Fetch local user profile
    const account = db.prepare(`
      SELECT id, username, display_name, bio, avatar_url,
             (SELECT COUNT(*) FROM events WHERE account_id = accounts.id AND visibility IN ('public','unlisted')) AS events_count,
             (SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) + (SELECT COUNT(*) FROM remote_follows WHERE account_id = accounts.id) AS followers_count
      FROM accounts WHERE username = ?
    `).get(username) as {
      id: string;
      username: string;
      display_name: string | null;
      bio: string | null;
      avatar_url: string | null;
      events_count: number;
      followers_count: number;
    } | undefined;

    if (!account) {
      console.log(`[OG] Profile not found: /@${username}`);
      return c.text("", 404);
    }

    const profileUrl = `${baseUrl}/@${username}`;

    // Use avatar as OG image if available
    let imageUrl = `${baseUrl}/og-image.png`;
    if (account.avatar_url) {
      imageUrl = account.avatar_url.startsWith("http")
        ? account.avatar_url
        : `${baseUrl}${account.avatar_url}`;
    }

    // Build description
    const displayName = account.display_name || account.username;
    let description = `@${account.username}`;
    if (account.bio) {
      description = account.bio.slice(0, 200);
    } else {
      const eventText = account.events_count === 1 ? "event" : "events";
      const followerText = account.followers_count === 1 ? "follower" : "followers";
      description = `${displayName} on EveryCal · ${account.events_count} ${eventText} · ${account.followers_count} ${followerText}`;
    }

    const tags = {
      title: `${displayName} (@${username})`,
      description,
      image: imageUrl,
      url: profileUrl,
      type: "profile",
    };

    console.log(`[OG] Rendering profile OG tags for: /@${username}`);

    const html = await renderOgHtml(tags);
    return c.html(html);
  });

  return router;
}
