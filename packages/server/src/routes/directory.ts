/**
 * Mastodon-compatible directory API — allows other federated servers to discover our profiles.
 *
 * GET /api/v1/directory — List discoverable accounts in Mastodon Account format.
 * Public, no auth. Used when Mastodon/Pleroma instances connect to EveryCal.
 */

import { Hono } from "hono";
import type { DB } from "../db.js";

function getBaseUrl(): string {
  return process.env.BASE_URL || "http://localhost:3000";
}

/** Convert bio to HTML if plain text (Mastodon expects HTML in note). */
function bioToNote(bio: string | null): string {
  if (!bio) return "";
  if (bio.includes("<")) return bio; // Already HTML
  return bio
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

export function directoryRoutes(db: DB): Hono {
  const router = new Hono();

  router.get("/directory", (c) => {
    const offset = parseInt(c.req.query("offset") || "0", 10);
    const limit = Math.min(parseInt(c.req.query("limit") || "40", 10), 80);
    const order = c.req.query("order") || "active";
    const baseUrl = getBaseUrl();

    const eventsCountSubquery = `(SELECT COUNT(*) FROM (
      SELECT e.id FROM events e WHERE e.account_id = accounts.id AND e.visibility IN ('public','unlisted')
      UNION
      SELECT r.event_id FROM reposts r JOIN events e ON e.id = r.event_id WHERE r.account_id = accounts.id AND e.visibility IN ('public','unlisted')
      UNION
      SELECT e.id FROM auto_reposts ar JOIN events e ON e.account_id = ar.source_account_id WHERE ar.account_id = accounts.id AND e.visibility = 'public'
    ))`;
    const lastEventSubquery = `(SELECT MAX(e.updated_at) FROM events e WHERE e.account_id = accounts.id AND e.visibility IN ('public','unlisted'))`;

    const orderClause =
      order === "new"
        ? "ORDER BY accounts.created_at DESC"
        : `ORDER BY COALESCE(${lastEventSubquery}, accounts.created_at) DESC`;

    const followersCountSubquery = `(SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) + (SELECT COUNT(*) FROM remote_follows WHERE account_id = accounts.id)`;

    const rows = db
      .prepare(
        `SELECT accounts.id, accounts.username, accounts.display_name, accounts.bio,
                accounts.avatar_url, accounts.is_bot, accounts.created_at,
                ${followersCountSubquery} AS followers_count,
                (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count,
                ${eventsCountSubquery} AS statuses_count,
                ${lastEventSubquery} AS last_status_at
         FROM accounts
         WHERE accounts.discoverable = 1
         ${orderClause}
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as Record<string, unknown>[];

    const accounts = rows.map((r) => {
      const username = r.username as string;
      const actorUrl = `${baseUrl}/users/${username}`;
      const profileUrl = `${baseUrl}/@${username}`;
      const lastStatusAt = r.last_status_at as string | null;
      const dateStr = lastStatusAt ? lastStatusAt.slice(0, 10) : null;

      return {
        id: String(r.id),
        username,
        acct: username,
        display_name: (r.display_name as string) || username,
        locked: false,
        bot: !!(r.is_bot as number),
        created_at: r.created_at,
        note: bioToNote(r.bio as string | null),
        url: profileUrl,
        avatar: (r.avatar_url as string) || null,
        avatar_static: (r.avatar_url as string) || null,
        header: null,
        header_static: null,
        followers_count: (r.followers_count as number) ?? 0,
        following_count: (r.following_count as number) ?? 0,
        statuses_count: (r.statuses_count as number) ?? 0,
        last_status_at: dateStr,
        discoverable: true,
        uri: actorUrl,
      };
    });

    return c.json(accounts);
  });

  return router;
}
