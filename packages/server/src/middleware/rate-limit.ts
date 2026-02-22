/**
 * Simple in-memory rate limiter middleware for Hono.
 *
 * Uses a sliding-window counter keyed by IP address.
 * Good enough for a single-server SQLite deployment.
 */

import { createMiddleware } from "hono/factory";
import { getLocale, t } from "../lib/i18n.js";

interface RateLimiterOptions {
  /** Window size in milliseconds. */
  windowMs: number;
  /** Maximum requests per window. */
  max: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function rateLimiter(opts: RateLimiterOptions) {
  const store = new Map<string, WindowEntry>();

  // Periodic cleanup to prevent memory leaks
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, opts.windowMs * 2);

  return createMiddleware(async (c, next) => {
    // Only trust X-Forwarded-For if TRUSTED_PROXY is set.
    // When behind a reverse proxy (nginx, cloudflare), set TRUSTED_PROXY=true.
    // Otherwise, use the direct connection address to prevent header spoofing.
    let ip: string;
    if (process.env.TRUSTED_PROXY === "true") {
      const forwarded = c.req.header("x-forwarded-for");
      ip = forwarded?.split(",")[0]?.trim() || "unknown";
    } else {
      // Use the underlying Node.js socket remote address when available
      const incoming = (c.env as Record<string, unknown>)?.incoming as
        | { socket?: { remoteAddress?: string } }
        | undefined;
      ip = incoming?.socket?.remoteAddress || "unknown";
    }

    // Skip rate limiting for loopback — local scripts and admin tools are trusted
    if (LOOPBACK_ADDRESSES.has(ip)) {
      await next();
      return;
    }

    const now = Date.now();

    let entry = store.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      store.set(ip, entry);
    }

    entry.count++;

    c.header("X-RateLimit-Limit", String(opts.max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, opts.max - entry.count)));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > opts.max) {
      return c.json({ error: t(getLocale(c), "common.too_many_requests") }, 429);
    }

    await next();
  });
}
