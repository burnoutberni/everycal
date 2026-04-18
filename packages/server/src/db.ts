/**
 * SQLite database initialization and schema management.
 */

import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./db/migrations.js";

export type DB = Database.Database;

const REQUIRED_TABLES = [
  "accounts",
  "sessions",
  "api_keys",
  "events",
  "event_tags",
  "follows",
  "identity_memberships",
  "remote_follows",
  "remote_actors",
  "remote_events",
  "remote_following",
  "domain_discovery",
  "event_rsvps",
  "reposts",
  "auto_reposts",
  "actor_selection_operations",
  "actor_selection_operation_items",
  "login_attempts",
  "calendar_feed_tokens",
  "saved_locations",
  "email_verification_tokens",
  "password_reset_tokens",
  "account_notification_prefs",
  "email_change_requests",
  "event_reminder_sent",
];

const REQUIRED_COLUMNS: Record<string, string[]> = {
  accounts: [
    "account_type",
    "timezone",
    "date_time_locale",
    "theme_preference",
    "default_event_visibility",
    "city",
    "city_lat",
    "city_lng",
    "email",
    "email_verified",
    "preferred_language",
  ],
  events: [
    "created_by_account_id",
    "slug",
    "start_at_utc",
    "end_at_utc",
    "event_timezone",
    "start_on",
    "end_on",
    "all_day",
    "content_hash",
    "canceled",
    "missing_since",
    "image_attribution",
    "og_image_url",
  ],
  remote_events: [
    "slug",
    "all_day",
    "start_at_utc",
    "end_at_utc",
    "start_on",
    "end_on",
    "event_timezone",
    "timezone_quality",
    "image_attribution",
    "canceled",
  ],
  remote_actors: ["followers_count", "following_count", "fetch_status", "last_error", "next_retry_at", "gone_at"],
  remote_follows: ["follower_shared_inbox"],
  remote_following: ["follow_activity_id", "follow_object_uri"],
  calendar_feed_tokens: ["token"],
  api_keys: ["key_prefix"],
};

function hasOnlySupportedRsvpStatuses(db: DB): boolean {
  const invalid = db
    .prepare("SELECT 1 AS bad FROM event_rsvps WHERE status IS NULL OR status NOT IN ('going','maybe') LIMIT 1")
    .get() as { bad: number } | undefined;
  return !invalid;
}

function tableExists(db: DB, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { ok: number } | undefined;
  return !!row?.ok;
}

function tableColumns(db: DB, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function hasUserTables(db: DB): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get() as { ok: number } | undefined;
  return !!row?.ok;
}

function schemaLooksLikeCurrentBaseline(db: DB): boolean {
  for (const table of REQUIRED_TABLES) {
    if (!tableExists(db, table)) return false;
  }

  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = tableColumns(db, table);
    for (const column of required) {
      if (!columns.has(column)) return false;
    }
  }

  if (!hasOnlySupportedRsvpStatuses(db)) return false;

  return true;
}

function applyPendingMigrations(db: DB, fromVersion: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;

    db.exec("BEGIN");
    try {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Failed database migration v${migration.version} (${migration.name}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

function assertSchemaIsSupported(db: DB): void {
  if (!schemaLooksLikeCurrentBaseline(db)) {
    throw new Error(
      "Unsupported legacy database schema detected. Legacy runtime migrations were intentionally removed; restore from an up-to-date backup or run a one-time offline migration before starting this build."
    );
  }
}

export function initDatabase(path: string): DB {
  const db = new Database(path);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion < 0) {
    throw new Error(`Invalid SQLite user_version: ${currentVersion}`);
  }
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than this server supports (${CURRENT_SCHEMA_VERSION}).`
    );
  }

  if (currentVersion === 0) {
    if (!hasUserTables(db)) {
      applyPendingMigrations(db, 0);
    } else {
      assertSchemaIsSupported(db);
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    }
  } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
    applyPendingMigrations(db, currentVersion);
  }

  assertSchemaIsSupported(db);
  return db;
}
