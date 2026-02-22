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
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail, sendEmailChangeVerificationEmail } from "../lib/email.js";
import { getLocale, t } from "../lib/i18n.js";

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
      return c.json({ error: t(getLocale(c), "auth.registration_closed") }, 403);
    }

    const body = await c.req.json<{
      username: string;
      email?: string;
      password?: string;
      displayName?: string;
      city?: string;
      cityLat?: number;
      cityLng?: number;
      isBot?: boolean;
    }>();

    if (!body.username) {
      return c.json({ error: t(getLocale(c), "auth.username_required") }, 400);
    }

    const username = body.username.toLowerCase().trim();
    if (!/^[a-z0-9_]{2,40}$/.test(username)) {
      return c.json({ error: t(getLocale(c), "auth.username_format") }, 400);
    }

    const isBot = !!body.isBot;

    // City required for non-bots; bots can use default
    const city = body.city || "Wien";
    const cityLat = body.cityLat ?? 48.2082;
    const cityLng = body.cityLng ?? 16.3738;
    if (!isBot && (body.city == null || body.cityLat == null || body.cityLng == null)) {
      return c.json({ error: t(getLocale(c), "auth.city_required") }, 400);
    }

    // Email required for non-bots
    const email = body.email?.trim().toLowerCase();
    if (!isBot) {
      if (!email) return c.json({ error: t(getLocale(c), "auth.email_required") }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return c.json({ error: t(getLocale(c), "auth.invalid_email") }, 400);
      }
    }

    // Password required for non-bots; optional for bots (API-key-only)
    if (!isBot) {
      if (!body.password || typeof body.password !== "string") {
        return c.json({ error: t(getLocale(c), "auth.password_required") }, 400);
      }
      if (body.password.length < 8) {
        return c.json({ error: t(getLocale(c), "auth.password_min_length") }, 400);
      }
    } else if (body.password !== undefined && body.password.length > 0 && body.password.length < 8) {
      return c.json({ error: t(getLocale(c), "auth.password_min_length") }, 400);
    }

    const existing = db.prepare("SELECT id FROM accounts WHERE username = ?").get(username);
    if (existing) {
      return c.json({ error: t(getLocale(c), "auth.username_taken") }, 409);
    }

    if (!isBot && email) {
      const existingEmail = db.prepare("SELECT id FROM accounts WHERE email = ?").get(email);
      if (existingEmail) {
        return c.json({ error: t(getLocale(c), "auth.email_registered") }, 409);
      }
    }

    const id = nanoid(16);
    const passwordHash = body.password ? hashPassword(body.password) : null;

    db.prepare(
      `INSERT INTO accounts (id, username, display_name, password_hash, email, email_verified, city, city_lat, city_lng, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      username,
      body.displayName || username,
      passwordHash,
      isBot ? null : email,
      isBot ? 1 : 0,
      city,
      cityLat,
      cityLng,
      isBot ? 1 : 0
    );

    // Create default notification prefs
    db.prepare(
      `INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled)
       VALUES (?, 1, 24, 1, 1)`
    ).run(id);

    if (isBot) {
      const session = createSession(db, id);
      setSessionCookie(c, session.token, session.expiresAt);
      return c.json(
        {
          user: { id, username, displayName: body.displayName || username, city, cityLat, cityLng },
          expiresAt: session.expiresAt,
        },
        201
      );
    }

    // Human: send verification email, no session
    const token = nanoid(48);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO email_verification_tokens (account_id, token, expires_at) VALUES (?, ?, ?)`
    ).run(id, token, expiresAt);

    await sendVerificationEmail(email!, token, getLocale(c));

    return c.json(
      {
        requiresVerification: true,
        email,
      },
      201
    );
  });

  // Verify email (registration or add/change email)
  router.get("/verify-email", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: t(getLocale(c), "auth.token_required") }, 400);
    }

    // Check email change request first (add/change email on existing account)
    const changeRow = db
      .prepare(
        `SELECT account_id, new_email FROM email_change_requests
         WHERE token = ? AND expires_at > datetime('now')`
      )
      .get(token) as { account_id: string; new_email: string } | undefined;

    if (changeRow) {
      db.prepare(
        `UPDATE accounts SET email = ?, email_verified = 1, email_verified_at = datetime('now') WHERE id = ?`
      ).run(changeRow.new_email, changeRow.account_id);
      db.prepare("DELETE FROM email_change_requests WHERE account_id = ?").run(changeRow.account_id);

      const account = db.prepare("SELECT username FROM accounts WHERE id = ?").get(changeRow.account_id) as { username: string };
      await sendWelcomeEmail(changeRow.new_email, account.username, getLocale(c));

      return c.json({
        ok: true,
        emailChanged: true,
        redirectTo: "/settings",
      });
    }

    // Registration flow
    const row = db
      .prepare(
        `SELECT evt.account_id, a.username, a.display_name, a.email
         FROM email_verification_tokens evt
         JOIN accounts a ON a.id = evt.account_id
         WHERE evt.token = ? AND evt.expires_at > datetime('now')`
      )
      .get(token) as { account_id: string; username: string; display_name: string | null; email: string } | undefined;

    if (!row) {
      return c.json({ error: t(getLocale(c), "auth.invalid_verification_link") }, 400);
    }

    db.prepare(
      `UPDATE accounts SET email_verified = 1, email_verified_at = datetime('now') WHERE id = ?`
    ).run(row.account_id);
    db.prepare("DELETE FROM email_verification_tokens WHERE account_id = ?").run(row.account_id);

    await sendWelcomeEmail(row.email, row.username, getLocale(c));

    const session = createSession(db, row.account_id);
    setSessionCookie(c, session.token, session.expiresAt);

    return c.json({
      user: {
        id: row.account_id,
        username: row.username,
        displayName: row.display_name,
        email: row.email,
        emailVerified: true,
      },
      expiresAt: session.expiresAt,
      redirectTo: "/onboarding",
    });
  });

  // Request add/change email (sends verification to new address)
  router.post("/request-email-change", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ email?: string }>();
    const newEmail = body.email?.trim().toLowerCase();

    if (!newEmail) {
      return c.json({ error: t(getLocale(c), "auth.email_required") }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return c.json({ error: t(getLocale(c), "auth.invalid_email") }, 400);
    }

    const existing = db.prepare("SELECT id FROM accounts WHERE email = ? AND id != ?").get(newEmail, user.id);
    if (existing) {
      return c.json({ error: t(getLocale(c), "auth.email_registered_other") }, 409);
    }

    const token = nanoid(48);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    db.prepare("DELETE FROM email_change_requests WHERE account_id = ?").run(user.id);
    db.prepare(
      `INSERT INTO email_change_requests (account_id, new_email, token, expires_at) VALUES (?, ?, ?, ?)`
    ).run(user.id, newEmail, token, expiresAt);

    await sendEmailChangeVerificationEmail(newEmail, token, getLocale(c));

    return c.json({ ok: true, email: newEmail });
  });

  // Change password (logged-in user)
  router.post("/change-password", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>();

    if (!body.currentPassword || !body.newPassword) {
      return c.json({ error: t(getLocale(c), "auth.current_and_new_password_required") }, 400);
    }
    if (body.newPassword.length < 8) {
      return c.json({ error: t(getLocale(c), "auth.new_password_min_length") }, 400);
    }

    const row = db
      .prepare("SELECT password_hash FROM accounts WHERE id = ?")
      .get(user.id) as { password_hash: string | null } | undefined;

    if (!row || !row.password_hash) {
      return c.json({ error: t(getLocale(c), "auth.no_password_set") }, 400);
    }
    if (!verifyPassword(body.currentPassword, row.password_hash)) {
      return c.json({ error: t(getLocale(c), "auth.current_password_incorrect") }, 401);
    }

    const passwordHash = hashPassword(body.newPassword);
    db.prepare("UPDATE accounts SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(
      passwordHash,
      user.id
    );

    return c.json({ ok: true });
  });

  // Login
  router.post("/login", async (c) => {
    const body = await c.req.json<{ username: string; password: string }>();

    if (!body.username || !body.password) {
      return c.json({ error: t(getLocale(c), "auth.username_password_required") }, 400);
    }

    const normalizedUsername = body.username.toLowerCase().trim();

    // Check account lockout (10 failed attempts → 15 min lockout)
    const lockout = checkLoginAttempt(db, normalizedUsername);
    if (lockout.locked) {
      return c.json(
        { error: t(getLocale(c), "auth.login_lockout", { minutes: lockout.remainingMinutes! }) },
        429
      );
    }

    const row = db
      .prepare(
        "SELECT id, username, display_name, password_hash, email_verified FROM accounts WHERE username = ?"
      )
      .get(normalizedUsername) as
      | {
          id: string;
          username: string;
          display_name: string | null;
          password_hash: string | null;
          email_verified: number;
        }
      | undefined;

    if (!row || !row.password_hash || !verifyPassword(body.password, row.password_hash)) {
      recordFailedLogin(db, normalizedUsername);
      return c.json({ error: t(getLocale(c), "auth.invalid_username_password") }, 401);
    }

    if (!row.email_verified) {
      return c.json({ error: t(getLocale(c), "auth.verify_email_first") }, 403);
    }

    // Successful login — clear failed attempts
    clearFailedLogins(db, normalizedUsername);

    const session = createSession(db, row.id);

    const prefsRow = db
      .prepare(
        `SELECT reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed
         FROM account_notification_prefs WHERE account_id = ?`
      )
      .get(row.id) as
      | {
          reminder_enabled: number;
          reminder_hours_before: number;
          event_updated_enabled: number;
          event_cancelled_enabled: number;
          onboarding_completed: number;
        }
      | undefined;

    const notificationPrefs = prefsRow
      ? {
          reminderEnabled: !!prefsRow.reminder_enabled,
          reminderHoursBefore: prefsRow.reminder_hours_before,
          eventUpdatedEnabled: !!prefsRow.event_updated_enabled,
          eventCancelledEnabled: !!prefsRow.event_cancelled_enabled,
          onboardingCompleted: !!prefsRow.onboarding_completed,
        }
      : {
          reminderEnabled: true,
          reminderHoursBefore: 24,
          eventUpdatedEnabled: true,
          eventCancelledEnabled: true,
          onboardingCompleted: false,
        };

    setSessionCookie(c, session.token, session.expiresAt);

    return c.json({
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        notificationPrefs,
      },
      expiresAt: session.expiresAt,
    });
  });

  // Forgot password
  router.post("/forgot-password", async (c) => {
    const body = await c.req.json<{ email?: string }>();
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      return c.json({ error: t(getLocale(c), "auth.email_required") }, 400);
    }

    const row = db
      .prepare("SELECT id, username FROM accounts WHERE email = ? AND email_verified = 1")
      .get(email) as { id: string; username: string } | undefined;

    if (row) {
      const token = nanoid(48);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      db.prepare(
        `INSERT OR REPLACE INTO password_reset_tokens (account_id, token, expires_at) VALUES (?, ?, ?)`
      ).run(row.id, token, expiresAt);
      await sendPasswordResetEmail(email, token, getLocale(c));
    }

    return c.json({ ok: true });
  });

  // Reset password
  router.post("/reset-password", async (c) => {
    const body = await c.req.json<{ token?: string; newPassword?: string }>();
    if (!body.token || !body.newPassword) {
      return c.json({ error: t(getLocale(c), "auth.token_and_password_required") }, 400);
    }
    if (body.newPassword.length < 8) {
      return c.json({ error: t(getLocale(c), "auth.password_min_length") }, 400);
    }

    const row = db
      .prepare(
        `SELECT prt.account_id FROM password_reset_tokens prt
         WHERE prt.token = ? AND prt.expires_at > datetime('now')`
      )
      .get(body.token) as { account_id: string } | undefined;

    if (!row) {
      return c.json({ error: t(getLocale(c), "auth.invalid_reset_link") }, 400);
    }

    const passwordHash = hashPassword(body.newPassword);
    db.prepare("UPDATE accounts SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(
      passwordHash,
      row.account_id
    );
    db.prepare("DELETE FROM password_reset_tokens WHERE account_id = ?").run(row.account_id);

    return c.json({ ok: true });
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
        `SELECT id, username, display_name, bio, avatar_url, website, is_bot, discoverable, city, city_lat, city_lng, email, email_verified, preferred_language, created_at,
                (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following_count,
                (SELECT COUNT(*) FROM follows WHERE following_id = ?) AS followers_count
         FROM accounts WHERE id = ?`
      )
      .get(user.id, user.id, user.id) as Record<string, unknown>;

    const prefsRow = db
      .prepare(
        `SELECT reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed
         FROM account_notification_prefs WHERE account_id = ?`
      )
      .get(user.id) as
      | {
          reminder_enabled: number;
          reminder_hours_before: number;
          event_updated_enabled: number;
          event_cancelled_enabled: number;
          onboarding_completed: number;
        }
      | undefined;

    const notificationPrefs = prefsRow
      ? {
          reminderEnabled: !!prefsRow.reminder_enabled,
          reminderHoursBefore: prefsRow.reminder_hours_before,
          eventUpdatedEnabled: !!prefsRow.event_updated_enabled,
          eventCancelledEnabled: !!prefsRow.event_cancelled_enabled,
          onboardingCompleted: !!prefsRow.onboarding_completed,
        }
      : {
          reminderEnabled: true,
          reminderHoursBefore: 24,
          eventUpdatedEnabled: true,
          eventCancelledEnabled: true,
          onboardingCompleted: false,
        };

    return c.json({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio,
      avatarUrl: row.avatar_url,
      website: row.website || null,
      isBot: !!row.is_bot,
      discoverable: !!row.discoverable,
      city: row.city || null,
      cityLat: row.city_lat != null ? Number(row.city_lat) : null,
      cityLng: row.city_lng != null ? Number(row.city_lng) : null,
      email: row.email || null,
      emailVerified: !!row.email_verified,
      preferredLanguage: row.preferred_language || "en",
      followingCount: row.following_count,
      followersCount: row.followers_count,
      createdAt: row.created_at,
      notificationPrefs,
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
      city?: string;
      cityLat?: number;
      cityLng?: number;
      preferredLanguage?: string;
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
          return c.json({ error: t(getLocale(c), "auth.avatar_url_http") }, 400);
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
            return c.json({ error: t(getLocale(c), "auth.website_http") }, 400);
          }
          fields.push("website = ?");
          values.push(body.website);
        } catch {
          return c.json({ error: t(getLocale(c), "auth.invalid_website_url") }, 400);
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
    if (body.city !== undefined && body.cityLat != null && body.cityLng != null) {
      fields.push("city = ?");
      values.push(body.city);
      fields.push("city_lat = ?");
      values.push(body.cityLat);
      fields.push("city_lng = ?");
      values.push(body.cityLng);
    }
    if (body.preferredLanguage !== undefined) {
      const valid = ["en", "de"];
      if (valid.includes(body.preferredLanguage)) {
        fields.push("preferred_language = ?");
        values.push(body.preferredLanguage);
      }
    }

    if (fields.length === 0) {
      return c.json({ error: t(getLocale(c), "auth.no_fields_to_update") }, 400);
    }

    fields.push("updated_at = datetime('now')");
    values.push(user.id);

    db.prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return c.json({ ok: true });
  });

  // Update notification preferences
  router.patch("/notification-prefs", requireAuth(), async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json<{
      reminderEnabled?: boolean;
      reminderHoursBefore?: number;
      eventUpdatedEnabled?: boolean;
      eventCancelledEnabled?: boolean;
      onboardingCompleted?: boolean;
    }>();

    const existing = db
      .prepare("SELECT account_id FROM account_notification_prefs WHERE account_id = ?")
      .get(user.id);

    const reminderEnabled = body.reminderEnabled ?? true;
    const reminderHoursBefore = body.reminderHoursBefore ?? 24;
    const eventUpdatedEnabled = body.eventUpdatedEnabled ?? true;
    const eventCancelledEnabled = body.eventCancelledEnabled ?? true;
    const onboardingCompleted = body.onboardingCompleted ?? false;

    const validHours = [1, 6, 12, 24];
    if (!validHours.includes(reminderHoursBefore)) {
      return c.json({ error: t(getLocale(c), "auth.reminder_hours_invalid") }, 400);
    }

    if (existing) {
      db.prepare(
        `UPDATE account_notification_prefs SET
          reminder_enabled = ?, reminder_hours_before = ?,
          event_updated_enabled = ?, event_cancelled_enabled = ?,
          onboarding_completed = ?
         WHERE account_id = ?`
      ).run(
        reminderEnabled ? 1 : 0,
        reminderHoursBefore,
        eventUpdatedEnabled ? 1 : 0,
        eventCancelledEnabled ? 1 : 0,
        onboardingCompleted ? 1 : 0,
        user.id
      );
    } else {
      db.prepare(
        `INSERT INTO account_notification_prefs (account_id, reminder_enabled, reminder_hours_before, event_updated_enabled, event_cancelled_enabled, onboarding_completed)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        user.id,
        reminderEnabled ? 1 : 0,
        reminderHoursBefore,
        eventUpdatedEnabled ? 1 : 0,
        eventCancelledEnabled ? 1 : 0,
        onboardingCompleted ? 1 : 0
      );
    }

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
    if (result.changes === 0) return c.json({ error: t(getLocale(c), "common.not_found") }, 404);
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
