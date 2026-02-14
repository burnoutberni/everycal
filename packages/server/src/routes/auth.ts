/**
 * Auth routes — register, login, logout, current user, API keys.
 */

import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../db.js";
import {
  hashPassword,
  verifyPassword,
  createSession,
  createApiKey,
  requireAuth,
} from "../middleware/auth.js";

export function authRoutes(db: DB): Hono {
  const router = new Hono();

  // Register
  router.post("/register", async (c) => {
    const body = await c.req.json<{
      username: string;
      password: string;
      displayName?: string;
    }>();

    if (!body.username || !body.password) {
      return c.json({ error: "Username and password are required" }, 400);
    }

    const username = body.username.toLowerCase().trim();
    if (!/^[a-z0-9_]{2,30}$/.test(username)) {
      return c.json(
        { error: "Username must be 2-30 characters, lowercase alphanumeric and underscores only" },
        400
      );
    }

    if (body.password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    const existing = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
    if (existing) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const id = nanoid(16);
    const passwordHash = hashPassword(body.password);

    db.prepare(
      `INSERT INTO accounts (id, username, display_name, password_hash)
       VALUES (?, ?, ?, ?)`
    ).run(id, username, body.displayName || username, passwordHash);

    const session = createSession(db, id);

    return c.json(
      {
        user: { id, username, displayName: body.displayName || username },
        token: session.token,
        expiresAt: session.expiresAt,
      },
      201
    );
  });

  // Login
  router.post("/login", async (c) => {
    const body = await c.req.json<{ username: string; password: string }>();

    if (!body.username || !body.password) {
      return c.json({ error: "Username and password are required" }, 400);
    }

    const row = db
      .prepare("SELECT id, username, display_name, password_hash FROM accounts WHERE username = ?")
      .get(body.username.toLowerCase().trim()) as
      | { id: string; username: string; display_name: string | null; password_hash: string }
      | undefined;

    if (!row || !verifyPassword(body.password, row.password_hash)) {
      return c.json({ error: "Invalid username or password" }, 401);
    }

    const session = createSession(db, row.id);

    return c.json({
      user: { id: row.id, username: row.username, displayName: row.display_name },
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  // Logout
  router.post("/logout", requireAuth(), (c) => {
    // Delete the session from the cookie/header
    const cookieHeader = c.req.header("cookie") || "";
    const sessionMatch = cookieHeader.match(/everycal_session=([^\s;]+)/);
    const token = sessionMatch?.[1];
    const authHeader = c.req.header("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    const t = token || bearerToken;
    if (t) {
      db.prepare("DELETE FROM sessions WHERE token = ?").run(t);
    }

    return c.json({ ok: true });
  });

  // Current user
  router.get("/me", requireAuth(), (c) => {
    const user = c.get("user")!;
    const row = db
      .prepare(
        `SELECT id, username, display_name, bio, avatar_url, created_at,
                (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
                (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS followers_count
         FROM accounts WHERE id = ?`
      )
      .get(user.id, user.id, user.id) as Record<string, unknown>;

    return c.json({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio,
      avatarUrl: row.avatar_url,
      followingCount: row.following_count,
      followersCount: row.followers_count,
      createdAt: row.created_at,
    });
  });

  // Update profile
  router.patch("/me", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
    }>();

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.displayName !== undefined) {
      fields.push("display_name = ?");
      values.push(body.displayName);
    }
    if (body.bio !== undefined) {
      fields.push("bio = ?");
      values.push(body.bio);
    }
    if (body.avatarUrl !== undefined) {
      fields.push("avatar_url = ?");
      values.push(body.avatarUrl);
    }

    if (fields.length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    fields.push("updated_at = datetime('now')");
    values.push(user.id);

    db.prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return c.json({ ok: true });
  });

  // ---- API Keys ----

  // List API keys
  router.get("/api-keys", requireAuth(), (c) => {
    const user = c.get("user")!;
    const rows = db
      .prepare(
        "SELECT id, label, last_used_at, created_at FROM api_keys WHERE account_id = ? ORDER BY created_at DESC"
      )
      .all(user.id) as { id: string; label: string; last_used_at: string | null; created_at: string }[];

    return c.json({
      keys: rows.map((r) => ({
        id: r.id,
        label: r.label,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
      })),
    });
  });

  // Create API key
  router.post("/api-keys", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ label?: string }>();
    const { id, key } = createApiKey(db, user.id, body.label || "Unnamed key");
    return c.json({ id, key, label: body.label || "Unnamed key" }, 201);
  });

  // Delete API key
  router.delete("/api-keys/:id", requireAuth(), (c) => {
    const user = c.get("user")!;
    const keyId = c.req.param("id");
    const result = db
      .prepare("DELETE FROM api_keys WHERE id = ? AND account_id = ?")
      .run(keyId, user.id);
    if (result.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  return router;
}
