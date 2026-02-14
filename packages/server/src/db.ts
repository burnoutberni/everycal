/**
 * SQLite database initialization and schema.
 */

import Database from "better-sqlite3";

export type DB = Database.Database;

export function initDatabase(path: string): DB {
  const db = new Database(path);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      bio TEXT,
      avatar_url TEXT,
      password_hash TEXT NOT NULL,
      private_key TEXT,
      public_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      external_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      location_name TEXT,
      location_address TEXT,
      location_latitude REAL,
      location_longitude REAL,
      location_url TEXT,
      image_url TEXT,
      image_media_type TEXT,
      image_alt TEXT,
      url TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_tags (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (event_id, tag)
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      following_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, following_id)
    );

    CREATE TABLE IF NOT EXISTS remote_follows (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      follower_actor_uri TEXT NOT NULL,
      follower_inbox TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, follower_actor_uri)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
    CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id);
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_date);
    CREATE INDEX IF NOT EXISTS idx_events_visibility ON events(visibility);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events(account_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
  `);

  return db;
}
