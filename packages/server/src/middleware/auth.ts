/**
 * Auth middleware — resolves the current user from session token or API key.
 *
 * Supports:
 *   - Cookie: everycal_session=<token>
 *   - Header: Authorization: Bearer <session-token>
 *   - Header: Authorization: ApiKey <key>
 */

import { createMiddleware } from "hono/factory";
import { nanoid } from "nanoid";
import bcrypt from "bcrypt";
import type { DB } from "../db.js";

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
}

// Extend Hono context variables
declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser | null;
  }
}

const SALT_ROUNDS = 12;
const SESSION_TTL_HOURS = 24 * 30; // 30 days

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
      return c.json({ error: "Authentication required" }, 401);
    }
    await next();
  });
}

// ---- session helpers ----

export function createSession(db: DB, accountId: string): { token: string; expiresAt: string } {
  const token = nanoid(48);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000).toISOString();
  db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    accountId,
    expiresAt
  );
  return { token, expiresAt };
}

function resolveSession(db: DB, token: string): AuthUser | null {
  const row = db
    .prepare(
      `SELECT a.id, a.username, a.display_name
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`
    )
    .get(token) as { id: string; username: string; display_name: string | null } | undefined;
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name };
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
  db.prepare("INSERT INTO api_keys (id, account_id, key_hash, label) VALUES (?, ?, ?, ?)").run(
    id,
    accountId,
    keyHash,
    label
  );
  return { id, key };
}

function resolveApiKey(db: DB, key: string): AuthUser | null {
  // We need to check all keys — not ideal at scale, but fine for SQLite single-server
  const rows = db
    .prepare(
      `SELECT k.id AS key_id, k.key_hash, a.id, a.username, a.display_name
       FROM api_keys k
       JOIN accounts a ON a.id = k.account_id`
    )
    .all() as { key_id: string; key_hash: string; id: string; username: string; display_name: string | null }[];

  for (const row of rows) {
    if (bcrypt.compareSync(key, row.key_hash)) {
      // Update last_used_at
      db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.key_id);
      return { id: row.id, username: row.username, displayName: row.display_name };
    }
  }
  return null;
}

// ---- password helpers ----

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}
