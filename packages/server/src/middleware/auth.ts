/**
 * Auth middleware — resolves the current user from session token or API key.
 *
 * Supports:
 *   - Cookie: everycal_session=<token>  (HttpOnly, preferred for web UI)
 *   - Header: Authorization: Bearer <session-token>
 *   - Header: Authorization: ApiKey <key>
 */

import { createMiddleware } from "hono/factory";
import { nanoid } from "nanoid";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import type { DB } from "../db.js";
import { getLocale, t } from "../lib/i18n.js";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  preferredLanguage?: string;
}

// Extend Hono context variables
declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser | null;
  }
}

const SALT_ROUNDS = 12;
const SESSION_TTL_HOURS = 24 * 30; // 30 days

/** Hash a session token with SHA-256 for secure storage. */
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function authMiddleware(db: DB) {
  return createMiddleware(async (c, next) => {
    let user: AuthUser | null = null;

    // Try cookie first
    const cookieHeader = c.req.header("cookie") || "";
    const sessionMatch = cookieHeader.match(/everycal_session=([^\s;]+)/);
    const token = sessionMatch?.[1];

    // Then try Authorization header
    const authHeader = c.req.header("authorization") || "";

    if (token) {
      user = resolveSession(db, token);
    } else if (authHeader.startsWith("Bearer ")) {
      user = resolveSession(db, authHeader.slice(7));
    } else if (authHeader.startsWith("ApiKey ")) {
      user = resolveApiKey(db, authHeader.slice(7));
    }

    c.set("user", user);
    await next();
  });
}

/** Middleware that rejects unauthenticated requests. */
export function requireAuth() {
  return createMiddleware(async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: t(getLocale(c), "common.authentication_required") }, 401);
    }
    await next();
  });
}

// ---- session helpers ----

export function createSession(db: DB, accountId: string): { token: string; expiresAt: string } {
  const token = nanoid(48);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000).toISOString();
  db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)").run(
    tokenHash,
    accountId,
    expiresAt
  );
  return { token, expiresAt };
}

function resolveSession(db: DB, token: string): AuthUser | null {
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT a.id, a.username, a.display_name, a.preferred_language
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(tokenHash) as {
      id: string;
      username: string;
      display_name: string | null;
      preferred_language: string | null;
    } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    preferredLanguage: row.preferred_language || undefined,
  };
}

// ---- API key helpers ----

export function createApiKey(
  db: DB,
  accountId: string,
  label: string
): { id: string; key: string } {
  const id = nanoid(12);
  const key = `ecal_${nanoid(40)}`;
  const keyHash = bcrypt.hashSync(key, SALT_ROUNDS);
  // Store a prefix (first 8 chars after ecal_) for fast lookup
  const keyPrefix = key.slice(5, 13);
  db.prepare("INSERT INTO api_keys (id, account_id, key_hash, key_prefix, label) VALUES (?, ?, ?, ?, ?)").run(
    id,
    accountId,
    keyHash,
    keyPrefix,
    label
  );
  return { id, key };
}

function resolveApiKey(db: DB, key: string): AuthUser | null {
  // Use the prefix to narrow the search before expensive bcrypt comparison
  const prefix = key.startsWith("ecal_") ? key.slice(5, 13) : null;

  let rows: {
    key_id: string;
    key_hash: string;
    id: string;
    username: string;
    display_name: string | null;
    preferred_language: string | null;
  }[];

  if (prefix) {
    // Fast path: lookup by prefix (typically 0-1 results)
    rows = db
      .prepare(
        `SELECT k.id AS key_id, k.key_hash, a.id, a.username, a.display_name, a.preferred_language
         FROM api_keys k
         JOIN accounts a ON a.id = k.account_id
         WHERE k.key_prefix = ?`
      )
      .all(prefix) as typeof rows;
  } else {
    // Fallback for legacy keys without prefix
    rows = db
      .prepare(
        `SELECT k.id AS key_id, k.key_hash, a.id, a.username, a.display_name, a.preferred_language
         FROM api_keys k
         JOIN accounts a ON a.id = k.account_id
         WHERE k.key_prefix IS NULL`
      )
      .all() as typeof rows;
  }

  for (const row of rows) {
    if (bcrypt.compareSync(key, row.key_hash)) {
      // Update last_used_at
      db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.key_id);
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        preferredLanguage: row.preferred_language || undefined,
      };
    }
  }
  return null;
}

// ---- session cleanup ----

/** Delete expired sessions from the database. */
export function cleanupExpiredSessions(db: DB): void {
  const result = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  if (result.changes > 0) {
    console.log(`🧹 Cleaned up ${result.changes} expired session(s)`);
  }
}

/** Delete a session by its raw (unhashed) token. */
export function deleteSession(db: DB, token: string): void {
  const tokenHash = hashToken(token);
  db.prepare("DELETE FROM sessions WHERE token = ?").run(tokenHash);
}

// ---- password helpers ----

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

// ---- account lockout helpers ----

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

/**
 * Check if a username is locked out due to too many failed login attempts.
 * Returns { locked: false } or { locked: true, remainingMinutes }.
 */
export function checkLoginAttempt(
  db: DB,
  username: string
): { locked: boolean; remainingMinutes?: number } {
  const row = db
    .prepare(
      `SELECT attempts, locked_until FROM login_attempts WHERE username = ?`
    )
    .get(username) as { attempts: number; locked_until: string | null } | undefined;

  if (!row) return { locked: false };

  if (row.locked_until) {
    const lockedUntil = new Date(row.locked_until).getTime();
    const now = Date.now();
    if (lockedUntil > now) {
      return {
        locked: true,
        remainingMinutes: Math.ceil((lockedUntil - now) / 60_000),
      };
    }
    // Lock has expired — reset
    db.prepare("DELETE FROM login_attempts WHERE username = ?").run(username);
    return { locked: false };
  }

  return { locked: false };
}

/** Record a failed login attempt for a username. Locks after MAX_FAILED_ATTEMPTS. */
export function recordFailedLogin(db: DB, username: string): void {
  const row = db
    .prepare("SELECT attempts FROM login_attempts WHERE username = ?")
    .get(username) as { attempts: number } | undefined;

  if (!row) {
    db.prepare(
      "INSERT INTO login_attempts (username, attempts, last_attempt) VALUES (?, 1, datetime('now'))"
    ).run(username);
    return;
  }

  const newCount = row.attempts + 1;
  if (newCount >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
    db.prepare(
      "UPDATE login_attempts SET attempts = ?, locked_until = ?, last_attempt = datetime('now') WHERE username = ?"
    ).run(newCount, lockedUntil, username);
  } else {
    db.prepare(
      "UPDATE login_attempts SET attempts = ?, last_attempt = datetime('now') WHERE username = ?"
    ).run(newCount, username);
  }
}

/** Clear failed login attempts after successful login. */
export function clearFailedLogins(db: DB, username: string): void {
  db.prepare("DELETE FROM login_attempts WHERE username = ?").run(username);
}
