/**
 * User routes — public profiles, follow/unfollow.
 */

import { Hono } from "hono";
import type { DB } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

export function userRoutes(db: DB): Hono {
  const router = new Hono();

  // List users (public)
  router.get("/", (c) => {
    const q = c.req.query("q") || "";
    const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    let sql: string;
    let params: unknown[];

    if (q) {
      sql = `SELECT id, username, display_name, bio, avatar_url, created_at,
                    (SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) AS followers_count,
                    (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count
             FROM accounts
             WHERE username LIKE ? OR display_name LIKE ?
             ORDER BY username ASC LIMIT ? OFFSET ?`;
      params = [`%${q}%`, `%${q}%`, limit, offset];
    } else {
      sql = `SELECT id, username, display_name, bio, avatar_url, created_at,
                    (SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) AS followers_count,
                    (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count
             FROM accounts
             ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params = [limit, offset];
    }

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return c.json({ users: rows.map(formatUser) });
  });

  // Get user profile
  router.get("/:username", (c) => {
    const username = c.req.param("username");
    const currentUser = c.get("user");

    const row = db
      .prepare(
        `SELECT id, username, display_name, bio, avatar_url, created_at,
                (SELECT COUNT(*) FROM follows WHERE following_id = accounts.id) AS followers_count,
                (SELECT COUNT(*) FROM follows WHERE follower_id = accounts.id) AS following_count
         FROM accounts WHERE username = ?`
      )
      .get(username) as Record<string, unknown> | undefined;

    if (!row) return c.json({ error: "User not found" }, 404);

    const result = formatUser(row);

    // Add follow status if logged in
    if (currentUser) {
      const follow = db
        .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
        .get(currentUser.id, row.id);
      result.following = !!follow;
    }

    return c.json(result);
  });

  // Get user's events
  router.get("/:username/events", (c) => {
    const username = c.req.param("username");
    const currentUser = c.get("user");
    const from = c.req.query("from");
    const to = c.req.query("to");
    const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
    const offset = parseInt(c.req.query("offset") || "0", 10);

    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: "User not found" }, 404);

    const isOwner = currentUser?.id === account.id;
    const isFollower = currentUser
      ? !!db
          .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?")
          .get(currentUser.id, account.id)
      : false;

    // Determine which visibilities this viewer can see
    const visibilities = ["'public'", "'unlisted'"];
    if (isFollower) visibilities.push("'followers_only'");
    if (isOwner) visibilities.push("'private'");

    let sql = `
      SELECT e.*, GROUP_CONCAT(t.tag) AS tags
      FROM events e
      LEFT JOIN event_tags t ON t.event_id = e.id
      WHERE e.account_id = ?
        AND e.visibility IN (${visibilities.join(",")})
    `;
    const params: unknown[] = [account.id];

    if (from) {
      sql += ` AND e.start_date >= ?`;
      params.push(from);
    }
    if (to) {
      sql += ` AND e.start_date <= ?`;
      params.push(to);
    }

    sql += ` GROUP BY e.id ORDER BY e.start_date ASC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return c.json({ events: rows.map(formatEvent) });
  });

  // Follow a user
  router.post("/:username/follow", requireAuth(), (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");

    const target = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!target) return c.json({ error: "User not found" }, 404);
    if (target.id === currentUser.id) return c.json({ error: "Cannot follow yourself" }, 400);

    db.prepare(
      "INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)"
    ).run(currentUser.id, target.id);

    return c.json({ ok: true, following: true });
  });

  // Unfollow a user
  router.post("/:username/unfollow", requireAuth(), (c) => {
    const currentUser = c.get("user")!;
    const username = c.req.param("username");

    const target = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!target) return c.json({ error: "User not found" }, 404);

    db.prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?").run(
      currentUser.id,
      target.id
    );

    return c.json({ ok: true, following: false });
  });

  // Get followers
  router.get("/:username/followers", (c) => {
    const username = c.req.param("username");
    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: "User not found" }, 404);

    const rows = db
      .prepare(
        `SELECT a.id, a.username, a.display_name, a.avatar_url
         FROM follows f
         JOIN accounts a ON a.id = f.follower_id
         WHERE f.following_id = ?
         ORDER BY f.created_at DESC`
      )
      .all(account.id) as Record<string, unknown>[];

    return c.json({ users: rows.map(formatUser) });
  });

  // Get following
  router.get("/:username/following", (c) => {
    const username = c.req.param("username");
    const account = db
      .prepare("SELECT id FROM accounts WHERE username = ?")
      .get(username) as { id: string } | undefined;
    if (!account) return c.json({ error: "User not found" }, 404);

    const rows = db
      .prepare(
        `SELECT a.id, a.username, a.display_name, a.avatar_url
         FROM follows f
         JOIN accounts a ON a.id = f.following_id
         WHERE f.follower_id = ?
         ORDER BY f.created_at DESC`
      )
      .all(account.id) as Record<string, unknown>[];

    return c.json({ users: rows.map(formatUser) });
  });

  return router;
}

function formatUser(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    followersCount: row.followers_count ?? 0,
    followingCount: row.following_count ?? 0,
    createdAt: row.created_at,
  };
}

function formatEvent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    accountId: row.account_id,
    title: row.title,
    description: row.description,
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: !!row.all_day,
    location: row.location_name
      ? {
          name: row.location_name,
          address: row.location_address,
          latitude: row.location_latitude,
          longitude: row.location_longitude,
          url: row.location_url,
        }
      : null,
    image: row.image_url
      ? { url: row.image_url, mediaType: row.image_media_type, alt: row.image_alt }
      : null,
    url: row.url,
    tags: row.tags ? (row.tags as string).split(",") : [],
    visibility: row.visibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
