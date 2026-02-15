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
  deleteSession,
  checkLoginAttempt,
  recordFailedLogin,
  clearFailedLogins,
} from "../middleware/auth.js";
import { stripHtml, sanitizeHtml, isValidHttpUrl } from "../lib/security.js";

export function authRoutes(db: DB): Hono {
  const router = new Hono();

  /** Set the session cookie with secure flags. */
  function setSessionCookie(c: { header: (name: string, value: string) => void }, token: string, expiresAt: string) {
    const maxAge = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
    const isProduction = process.env.NODE_ENV === "production";
    const parts = [
      `everycal_session=${token}`,
      "HttpOnly",
      "Path=/",
      `Max-Age=${maxAge}`,
      "SameSite=Lax",
    ];
    if (isProduction) parts.push("Secure");
    c.header("Set-Cookie", parts.join("; "));
  }

  /** Clear the session cookie. */
  function clearSessionCookie(c: { header: (name: string, value: string) => void }) {
    const isProduction = process.env.NODE_ENV === "production";
    const parts = [
      "everycal_session=",
      "HttpOnly",
      "Path=/",
      "Max-Age=0",
      "SameSite=Lax",
    ];
    if (isProduction) parts.push("Secure");
    c.header("Set-Cookie", parts.join("; "));
  }

  // Register
  router.post("/register", async (c) => {
    // Check if open registration is enabled
    if (process.env.OPEN_REGISTRATIONS === "false") {
      return c.json({ error: "Registration is currently closed" }, 403);
    }

    const body = await c.req.json<{
      username: string;
      password?: string;
      displayName?: string;
    }>();

    if (!body.username) {
      return c.json({ error: "Username is required" }, 400);
    }

    const username = body.username.toLowerCase().trim();
    if (!/^[a-z0-9_]{2,40}$/.test(username)) {
      return c.json(
        { error: "Username must be 2-40 characters: letters, numbers, and underscores only" },
        400
      );
    }

    // Password is optional — accounts without a password can only authenticate
    // via API key and can never log in with a password.
    if (body.password !== undefined && body.password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    const existing = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
    if (existing) {
      return c.json({ error: "Username already taken" }, 409);
    }

    const id = nanoid(16);
    const passwordHash = body.password ? hashPassword(body.password) : null;

    db.prepare(
      `INSERT INTO accounts (id, username, display_name, password_hash)
       VALUES (?, ?, ?, ?)`
    ).run(id, username, body.displayName || username, passwordHash);

    const session = createSession(db, id);

    setSessionCookie(c, session.token, session.expiresAt);

    return c.json(
      {
        user: { id, username, displayName: body.displayName || username },
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

    const normalizedUsername = body.username.toLowerCase().trim();

    // Check account lockout (10 failed attempts → 15 min lockout)
    const lockout = checkLoginAttempt(db, normalizedUsername);
    if (lockout.locked) {
      return c.json(
        { error: `Too many failed login attempts. Try again in ${lockout.remainingMinutes} minute(s).` },
        429
      );
    }

    const row = db
      .prepare("SELECT id, username, display_name, password_hash FROM accounts WHERE username = ?")
      .get(normalizedUsername) as
      | { id: string; username: string; display_name: string | null; password_hash: string | null }
      | undefined;

    if (!row || !row.password_hash || !verifyPassword(body.password, row.password_hash)) {
      recordFailedLogin(db, normalizedUsername);
      return c.json({ error: "Invalid username or password" }, 401);
    }

    // Successful login — clear failed attempts
    clearFailedLogins(db, normalizedUsername);

    const session = createSession(db, row.id);

    setSessionCookie(c, session.token, session.expiresAt);

    return c.json({
      user: { id: row.id, username: row.username, displayName: row.display_name },
      expiresAt: session.expiresAt,
    });
  });

  // Logout
  router.post("/logout", requireAuth(), (c) => {
    const cookieHeader = c.req.header("cookie") || "";
    const sessionMatch = cookieHeader.match(/everycal_session=([^\s;]+)/);
    const token = sessionMatch?.[1];
    const authHeader = c.req.header("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    const t = token || bearerToken;
    if (t) {
      deleteSession(db, t);
    }

    clearSessionCookie(c);

    return c.json({ ok: true });
  });

  // Current user
  router.get("/me", requireAuth(), (c) => {
    const user = c.get("user")!;
    const row = db
      .prepare(
        `SELECT id, username, display_name, bio, avatar_url, website, is_bot, discoverable, created_at,
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
      website: row.website || null,
      isBot: !!row.is_bot,
      discoverable: !!row.discoverable,
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
      website?: string;
      isBot?: boolean;
      discoverable?: boolean;
    }>();

    const fields: string[] = [];
    const values: unknown[] = [];

    if (body.displayName !== undefined) {
      fields.push("display_name = ?");
      values.push(stripHtml(body.displayName));
    }
    if (body.bio !== undefined) {
      fields.push("bio = ?");
      values.push(sanitizeHtml(body.bio));
    }
    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl) {
        if (!isValidHttpUrl(body.avatarUrl)) {
          return c.json({ error: "Avatar URL must be an HTTP(S) URL" }, 400);
        }
        fields.push("avatar_url = ?");
        values.push(body.avatarUrl);
      } else {
        fields.push("avatar_url = ?");
        values.push(null);
      }
    }
    if (body.website !== undefined) {
      // Validate website URL
      if (body.website) {
        try {
          const url = new URL(body.website);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            return c.json({ error: "Website must be an HTTP(S) URL" }, 400);
          }
          fields.push("website = ?");
          values.push(body.website);
        } catch {
          return c.json({ error: "Invalid website URL" }, 400);
        }
      } else {
        fields.push("website = ?");
        values.push(null);
      }
    }
    if (body.isBot !== undefined) {
      fields.push("is_bot = ?");
      values.push(body.isBot ? 1 : 0);
    }
    if (body.discoverable !== undefined) {
      fields.push("discoverable = ?");
      values.push(body.discoverable ? 1 : 0);
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

  // Delete account and all associated data
  router.delete("/me", requireAuth(), (c) => {
    const user = c.get("user")!;

    const deleteAccount = db.transaction(() => {
      // Delete events + their tags (events table lacks ON DELETE CASCADE)
      const eventIds = db
        .prepare("SELECT id FROM events WHERE account_id = ?")
        .all(user.id) as { id: string }[];
      if (eventIds.length > 0) {
        const deleteTags = db.prepare("DELETE FROM event_tags WHERE event_id = ?");
        const deleteEvent = db.prepare("DELETE FROM events WHERE id = ?");
        for (const { id } of eventIds) {
          deleteTags.run(id);
          deleteEvent.run(id);
        }
      }

      // Delete remote_follows (lacks ON DELETE CASCADE)
      db.prepare("DELETE FROM remote_follows WHERE account_id = ?").run(user.id);

      // Delete the account — cascades to sessions, api_keys, follows,
      // remote_following, event_rsvps, reposts, auto_reposts
      db.prepare("DELETE FROM accounts WHERE id = ?").run(user.id);
    });

    deleteAccount();
    return c.json({ ok: true });
  });

  return router;
}
