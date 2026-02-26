/**
 * OG tag rendering routes.
 *
 * Provides server-side rendered OG tags for crawlers on event and profile pages.
 * Falls through to SPA for regular users.
 */

import { Hono } from "hono";
import type { DB } from "../db.js";
import { isCrawler } from "../lib/crawler.js";
import { renderOgHtml, loadIndexHtml } from "../lib/og-html.js";

export function ogRenderRoutes(db: DB): Hono {
  const router = new Hono();

  // Preload index.html at startup (in production)
  if (process.env.NODE_ENV === "production") {
    loadIndexHtml();
  }

  // GET /@:username/:slug — Event page OG rendering
  router.get("/@:username/:slug", async (c, next) => {
    // Only handle in production
    if (process.env.NODE_ENV !== "production") {
      return next();
    }

    const userAgent = c.req.header("user-agent");
    if (!isCrawler(userAgent)) {
      return next();
    }

    const username = c.req.param("username");
    const slug = c.req.param("slug");

    // Skip if username or slug is missing (shouldn't happen with route params)
    if (!username || !slug) {
      return next();
    }

    // Skip remote profiles (username@domain format)
    if (username.includes("@")) {
      return next();
    }

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";

    // Fetch the event from the database (only public/unlisted events)
    const event = db.prepare(`
      SELECT e.*, a.username AS account_username, a.display_name AS account_display_name
      FROM events e
      JOIN accounts a ON a.id = e.account_id
      WHERE a.username = ? AND e.slug = ? AND e.visibility IN ('public', 'unlisted')
    `).get(username, slug) as {
      id: string;
      title: string;
      description: string | null;
      og_image_url: string | null;
      start_date: string;
      location_name: string | null;
      account_username: string;
      account_display_name: string;
    } | undefined;

    if (!event) {
      return next();
    }

    // Build OG tags
    const eventUrl = `${baseUrl}/@${username}/${slug}`;

    // Format description from event description or location
    let description = "";
    if (event.description) {
      // Strip HTML tags for description
      description = event.description.replace(/<[^>]*>/g, "").trim();
    }
    if (!description && event.location_name) {
      description = `Location: ${event.location_name}`;
    }
    if (!description) {
      description = `Event by @${username}`;
    }

    // Format date
    try {
      const date = new Date(event.start_date);
      description = `${date.toLocaleDateString()} — ${description}`;
    } catch {
      // Keep description as-is if date parsing fails
    }

    // Determine OG image (prefer og_image_url, fallback to default)
    const ogImage = event.og_image_url
      ? `${baseUrl}${event.og_image_url}`
      : `${baseUrl}/og-image.png`;

    const tags = {
      title: event.title,
      description,
      image: ogImage,
      url: eventUrl,
      type: "article",
      twitterCard: "summary_large_image" as const,
    };

    return c.html(renderOgHtml(tags));
  });

  // GET /@:username — Profile page OG rendering
  router.get("/@:username", async (c, next) => {
    // Only handle in production
    if (process.env.NODE_ENV !== "production") {
      return next();
    }

    const userAgent = c.req.header("user-agent");
    if (!isCrawler(userAgent)) {
      return next();
    }

    const username = c.req.param("username");

    // Skip if username is missing (shouldn't happen with route params)
    if (!username) {
      return next();
    }

    // Skip remote profiles (username@domain format) - fall through to SPA
    if (username.includes("@")) {
      return next();
    }

    const baseUrl = process.env.BASE_URL || "http://localhost:3000";

    // Fetch the user profile
    const account = db.prepare(`
      SELECT id, username, display_name, bio, avatar_url
      FROM accounts
      WHERE username = ?
    `).get(username) as {
      id: string;
      username: string;
      display_name: string | null;
      bio: string | null;
      avatar_url: string | null;
    } | undefined;

    if (!account) {
      return next();
    }

    // Build OG tags
    const profileUrl = `${baseUrl}/@${username}`;

    // Build description from bio or default
    let description = account.bio
      ? account.bio.replace(/<[^>]*>/g, "").trim()
      : `View ${account.display_name || username}'s profile on EveryCal`;

    // Get events count
    const eventsCount = db.prepare(`
      SELECT COUNT(*) as count FROM events WHERE account_id = ? AND visibility IN ('public', 'unlisted')
    `).get(account.id) as { count: number };

    if (eventsCount.count > 0) {
      description += ` — ${eventsCount.count} public event${eventsCount.count !== 1 ? "s" : ""}`;
    }

    // Use avatar as OG image if available
    const ogImage = account.avatar_url
      ? account.avatar_url.startsWith("http")
        ? account.avatar_url
        : `${baseUrl}${account.avatar_url}`
      : `${baseUrl}/og-image.png`;

    const displayName = account.display_name || username;

    const tags = {
      title: `${displayName} (@${username}) — EveryCal`,
      description,
      image: ogImage,
      url: profileUrl,
      type: "profile",
      twitterCard: "summary" as const,
    };

    return c.html(renderOgHtml(tags));
  });

  return router;
}
