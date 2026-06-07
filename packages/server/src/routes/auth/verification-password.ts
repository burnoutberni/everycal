import type { Hono } from "hono";
import { nanoid } from "nanoid";
import type { DB } from "../../db.js";
import { hashPassword, verifyPassword, createSession, requireAuth } from "../../middleware/auth.js";
import { sendWelcomeEmail, sendPasswordResetEmail, sendEmailChangeVerificationEmail } from "../../lib/email.js";
import { getLocale, t } from "../../lib/i18n.js";
import { PASSWORD_MIN_LENGTH, meetsPasswordMinLength } from "@everycal/core";
import { parseJsonBody } from "../../lib/request-body.js";
import { findByTokenHash, hashTokenSecret } from "../../lib/token-secrets.js";
import { setSessionCookie } from "./session-cookies.js";
import { getLocalAuthConfig } from "../../lib/oidc.js";

export function registerVerificationPasswordRoutes(router: Hono, db: DB): void {
  router.get("/verify-email", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: t(getLocale(c), "auth.token_required") }, 400);
    }

    // Check email change request first (add/change email on existing account)
    const changeRow = findByTokenHash<{ account_id: string; new_email: string }>(
      db,
      `SELECT account_id, new_email FROM email_change_requests
         WHERE token = ? AND expires_at > datetime('now')`,
      token
    );

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
    const row = findByTokenHash<{ account_id: string; username: string; display_name: string | null; email: string }>(
      db,
      `SELECT evt.account_id, a.username, a.display_name, a.email
         FROM email_verification_tokens evt
         JOIN accounts a ON a.id = evt.account_id
         WHERE evt.token = ? AND evt.expires_at > datetime('now')`,
      token
    );

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
    const parsed = await parseJsonBody<{ email?: string }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;
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
    db.prepare("DELETE FROM email_change_requests WHERE account_id = ?").run(user.id);
    db.prepare(
      `INSERT INTO email_change_requests (account_id, new_email, token, expires_at)
       VALUES (?, ?, ?, datetime('now', '+1 day'))`
    ).run(user.id, newEmail, hashTokenSecret(token));

    await sendEmailChangeVerificationEmail(newEmail, token, getLocale(c));

    return c.json({ ok: true, email: newEmail });
  });

  // Change password (logged-in user)
  router.post("/change-password", requireAuth(), async (c) => {
    if (getLocalAuthConfig().passwordAuthDisabled) {
      return c.json({ error: "local_auth_disabled" }, 403);
    }
    const user = c.get("user")!;
    const parsed = await parseJsonBody<{ currentPassword?: unknown; newPassword?: unknown }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;

    if (
      typeof body.currentPassword !== "string" ||
      typeof body.newPassword !== "string" ||
      !body.currentPassword ||
      !body.newPassword
    ) {
      return c.json({ error: t(getLocale(c), "auth.current_and_new_password_required") }, 400);
    }
    if (!meetsPasswordMinLength(body.newPassword, PASSWORD_MIN_LENGTH)) {
      return c.json({ error: t(getLocale(c), "auth.new_password_min_length", { min: PASSWORD_MIN_LENGTH }) }, 400);
    }

    const row = db
      .prepare("SELECT password_hash, is_bot FROM accounts WHERE id = ?")
      .get(user.id) as { password_hash: string | null; is_bot: number } | undefined;

    if (row?.is_bot) {
      return c.json({ error: t(getLocale(c), "auth.bot_password_not_allowed") }, 400);
    }

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

  router.post("/forgot-password", async (c) => {
    if (getLocalAuthConfig().passwordAuthDisabled) {
      return c.json({ error: "local_auth_disabled" }, 403);
    }
    const parsed = await parseJsonBody<{ email?: string }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;
    const email = body.email?.trim().toLowerCase();
    if (!email) {
      return c.json({ error: t(getLocale(c), "auth.email_required") }, 400);
    }

    const row = db
      .prepare("SELECT id, username FROM accounts WHERE email = ? AND email_verified = 1 AND is_bot = 0")
      .get(email) as { id: string; username: string } | undefined;

    if (row) {
      const token = nanoid(48);
      db.prepare(
        `INSERT OR REPLACE INTO password_reset_tokens (account_id, token, expires_at)
         VALUES (?, ?, datetime('now', '+1 hour'))`
      ).run(row.id, hashTokenSecret(token));
      await sendPasswordResetEmail(email, token, getLocale(c));
    }

    return c.json({ ok: true });
  });

  // Reset password
  router.post("/reset-password", async (c) => {
    if (getLocalAuthConfig().passwordAuthDisabled) {
      return c.json({ error: "local_auth_disabled" }, 403);
    }
    const parsed = await parseJsonBody<{ token?: unknown; newPassword?: unknown }>(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed;
    if (
      typeof body.token !== "string" ||
      typeof body.newPassword !== "string" ||
      !body.token ||
      !body.newPassword
    ) {
      return c.json({ error: t(getLocale(c), "auth.token_and_password_required") }, 400);
    }
    if (!meetsPasswordMinLength(body.newPassword, PASSWORD_MIN_LENGTH)) {
      return c.json({ error: t(getLocale(c), "auth.password_min_length", { min: PASSWORD_MIN_LENGTH }) }, 400);
    }

    const row = findByTokenHash<{ account_id: string; is_bot: number }>(
      db,
      `SELECT prt.account_id, a.is_bot FROM password_reset_tokens prt
         JOIN accounts a ON a.id = prt.account_id
         WHERE prt.token = ? AND prt.expires_at > datetime('now')`,
      body.token
    );

    if (!row || row.is_bot) {
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
}
