/**
 * SQLite database initialization and schema management.
 */

import Database from "better-sqlite3";
import { toErrorMessage } from "@everycal/core";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./db/migrations.js";
import type { Migration } from "./db/migrations.js";
import { validateBaseUrlConfig } from "./lib/base-url.js";

export type DB = Database.Database;

const CANONICAL_REPOST_MIGRATION_VERSION = 10;

function hasUserTables(db: DB): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get() as { ok: number } | undefined;
  return !!row?.ok;
}

function hasTable(db: DB, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { ok: number } | undefined;
  return !!row?.ok;
}

type RequiredIndex = {
  table: string;
  name: string;
  unique: boolean;
  columns: Array<{ name: string; desc?: boolean }>;
  where?: string;
};

const REQUIRED_TABLE_COLUMNS: Record<string, string[]> = {
  accounts: [
    "id",
    "username",
    "account_type",
    "display_name",
    "bio",
    "avatar_url",
    "password_hash",
    "private_key",
    "public_key",
    "is_bot",
    "discoverable",
    "timezone",
    "date_time_locale",
    "theme_preference",
    "default_event_visibility",
    "created_at",
    "updated_at",
    "website",
    "city",
    "city_lat",
    "city_lng",
    "email",
    "email_verified",
    "email_verified_at",
    "preferred_language",
    "calendar_feed_token_version",
    "is_admin",
    "is_disabled",
    "sso_admin_locked",
    "auth_source",
    "last_oidc_login_at",
    "oidc_profile_synced_at",
  ],
  sessions: ["token", "account_id", "created_at", "expires_at", "auth_method"],
  api_keys: ["id", "account_id", "key_hash", "label", "last_used_at", "created_at", "key_prefix"],
  account_auth_identities: ["id", "account_id", "provider_key", "issuer", "subject", "email_at_link_time", "claims_json", "last_login_at", "created_at", "updated_at"],
  account_role_assignments: ["id", "account_id", "role_key", "source", "managed_by", "created_at", "updated_at"],
  oidc_login_states: ["id", "provider_key", "state_hash", "nonce_hash", "code_verifier_hash", "redirect_to", "created_at", "expires_at", "consumed_at"],
  events: [
    "id",
    "account_id",
    "created_by_account_id",
    "external_id",
    "slug",
    "title",
    "description",
    "start_date",
    "end_date",
    "start_at_utc",
    "end_at_utc",
    "event_timezone",
    "start_on",
    "end_on",
    "all_day",
    "location_name",
    "location_address",
    "location_latitude",
    "location_longitude",
    "location_url",
    "image_url",
    "image_media_type",
    "image_alt",
    "image_attribution",
    "og_image_url",
    "url",
    "visibility",
    "content_hash",
    "canceled",
    "missing_since",
    "created_at",
    "updated_at",
    "moderation_state",
    "moderation_reason",
    "flagger_note",
    "flagged_at",
    "moderated_at",
  ],
  event_tags: ["event_id", "tag"],
  follows: ["follower_id", "following_id", "created_at"],
  identity_memberships: ["identity_account_id", "member_account_id", "role", "created_at"],
  remote_follows: ["account_id", "follower_actor_uri", "follower_inbox", "follower_shared_inbox", "created_at"],
  remote_actors: [
    "uri",
    "type",
    "preferred_username",
    "display_name",
    "summary",
    "inbox",
    "outbox",
    "shared_inbox",
    "followers_url",
    "following_url",
    "icon_url",
    "image_url",
    "public_key_id",
    "public_key_pem",
    "domain",
    "followers_count",
    "following_count",
    "last_fetched_at",
    "fetch_status",
    "last_error",
    "next_retry_at",
    "gone_at",
    "created_at",
  ],
  remote_events: [
    "uri",
    "actor_uri",
    "slug",
    "title",
    "description",
    "start_date",
    "end_date",
    "all_day",
    "start_at_utc",
    "end_at_utc",
    "start_on",
    "end_on",
    "event_timezone",
    "timezone_quality",
    "location_name",
    "location_address",
    "location_latitude",
    "location_longitude",
    "image_url",
    "image_media_type",
    "image_alt",
    "image_attribution",
    "url",
    "tags",
    "raw_json",
    "published",
    "updated",
    "fetched_at",
    "canceled",
    "visibility",
    "og_image_url",
    "moderation_state",
  ],
  outbound_activity_deliveries: [
    "id",
    "destination_inbox",
    "sender_account_id",
    "sender_actor_uri",
    "sender_key_id",
    "activity_json",
    "attempt_count",
    "next_retry_at",
    "last_error",
    "state",
    "claimed_at",
    "worker_id",
    "created_at",
    "updated_at",
  ],
  processed_inbox_activities: [
    "activity_id",
    "actor_uri",
    "target_context",
    "status",
    "claimed_at",
    "processed_at",
    "last_error",
    "received_at",
  ],
  remote_following: ["account_id", "actor_uri", "actor_inbox", "follow_activity_id", "follow_object_uri", "created_at"],
  domain_discovery: ["domain", "last_discovered_at", "software_type"],
  event_rsvps: ["account_id", "event_uri", "status", "created_at"],
  remote_event_rsvps: [
    "event_id",
    "actor_uri",
    "status",
    "last_activity_id",
    "last_activity_type",
    "last_activity_published_at",
    "last_activity_precedence",
    "created_at",
    "updated_at",
  ],
  reposts: ["account_id", "event_id", "event_uri", "source_actor_uri", "created_at"],
  auto_reposts: ["account_id", "source_account_id", "source_actor_uri", "created_at"],
  federation_activity_ids: ["activity_id", "logical_key", "actor_uri", "activity_type", "object_uri", "created_at"],
  actor_selection_operations: [
    "id",
    "action_kind",
    "target_type",
    "target_id",
    "initiated_by_account_id",
    "status",
    "created_at",
    "completed_at",
  ],
  actor_selection_operation_items: [
    "operation_id",
    "account_id",
    "before_state",
    "after_state",
    "status",
    "remote_status",
    "message",
    "created_at",
  ],
  login_attempts: ["username", "attempts", "locked_until", "last_attempt"],
  calendar_feed_tokens: ["account_id", "token", "created_at"],
  saved_locations: ["id", "account_id", "name", "address", "latitude", "longitude", "used_at"],
  email_verification_tokens: ["account_id", "token", "expires_at"],
  password_reset_tokens: ["account_id", "token", "expires_at"],
  admin_audit_log: ["id", "admin_account_id", "action_type", "target_type", "target_id", "payload_json", "created_at"],
  admin_settings: ["key", "value_json", "updated_by_account_id", "updated_at"],
  admin_job_runs: [
    "id",
    "job_type",
    "status",
    "payload_json",
    "result_json",
    "created_by_account_id",
    "created_at",
    "started_at",
    "finished_at",
  ],
  federation_blocks: [
    "id",
    "block_type",
    "actor_uri",
    "domain",
    "created_by_account_id",
    "is_active",
    "created_at",
    "reason",
  ],
  federation_tombstones: ["id", "object_type", "object_id", "reason", "created_at", "expires_at"],
  account_notification_prefs: [
    "account_id",
    "reminder_enabled",
    "reminder_hours_before",
    "event_updated_enabled",
    "event_cancelled_enabled",
    "onboarding_completed",
  ],
  email_change_requests: ["account_id", "new_email", "token", "expires_at"],
  event_reminder_sent: ["account_id", "event_uri", "reminder_type", "sent_at"],
};

const REQUIRED_INDEXES: RequiredIndex[] = [
  { table: "sessions", name: "idx_sessions_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "sessions", name: "idx_sessions_expires", unique: false, columns: [{ name: "expires_at" }] },
  { table: "api_keys", name: "idx_api_keys_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "api_keys", name: "idx_api_keys_prefix", unique: false, columns: [{ name: "key_prefix" }] },
  { table: "account_auth_identities", name: "sqlite_autoindex_account_auth_identities_2", unique: true, columns: [{ name: "provider_key" }, { name: "issuer" }, { name: "subject" }] },
  { table: "account_auth_identities", name: "idx_account_auth_identities_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "account_auth_identities", name: "idx_account_auth_identities_provider_email", unique: false, columns: [{ name: "provider_key" }, { name: "email_at_link_time" }] },
  { table: "account_role_assignments", name: "sqlite_autoindex_account_role_assignments_2", unique: true, columns: [{ name: "account_id" }, { name: "role_key" }, { name: "source" }] },
  { table: "account_role_assignments", name: "idx_account_role_assignments_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "account_role_assignments", name: "idx_account_role_assignments_role", unique: false, columns: [{ name: "role_key" }] },
  { table: "oidc_login_states", name: "sqlite_autoindex_oidc_login_states_2", unique: true, columns: [{ name: "state_hash" }] },
  { table: "oidc_login_states", name: "idx_oidc_login_states_expires", unique: false, columns: [{ name: "expires_at" }] },
  { table: "events", name: "idx_events_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "events", name: "idx_events_visibility", unique: false, columns: [{ name: "visibility" }] },
  {
    table: "events",
    name: "idx_events_external",
    unique: true,
    columns: [{ name: "account_id" }, { name: "external_id" }],
    where: "external_id IS NOT NULL",
  },
  {
    table: "events",
    name: "idx_events_slug",
    unique: true,
    columns: [{ name: "account_id" }, { name: "slug" }],
    where: "slug IS NOT NULL",
  },
  { table: "events", name: "idx_events_start_at_utc", unique: false, columns: [{ name: "start_at_utc" }] },
  { table: "events", name: "idx_events_start_on", unique: false, columns: [{ name: "start_on" }] },
  { table: "follows", name: "idx_follows_follower", unique: false, columns: [{ name: "follower_id" }] },
  { table: "follows", name: "idx_follows_following", unique: false, columns: [{ name: "following_id" }] },
  {
    table: "identity_memberships",
    name: "idx_identity_memberships_member",
    unique: false,
    columns: [{ name: "member_account_id" }],
  },
  {
    table: "identity_memberships",
    name: "idx_identity_memberships_identity_role",
    unique: false,
    columns: [{ name: "identity_account_id" }, { name: "role" }],
  },
  { table: "remote_actors", name: "idx_remote_actors_domain", unique: false, columns: [{ name: "domain" }] },
  {
    table: "remote_actors",
    name: "idx_remote_actors_username",
    unique: false,
    columns: [{ name: "preferred_username" }, { name: "domain" }],
  },
  { table: "remote_events", name: "idx_remote_events_actor", unique: false, columns: [{ name: "actor_uri" }] },
  {
    table: "remote_events",
    name: "idx_remote_events_actor_slug",
    unique: true,
    columns: [{ name: "actor_uri" }, { name: "slug" }],
    where: "slug IS NOT NULL",
  },
  {
    table: "remote_events",
    name: "idx_remote_events_start_at_utc",
    unique: false,
    columns: [{ name: "start_at_utc" }],
  },
  { table: "remote_events", name: "idx_remote_events_start_on", unique: false, columns: [{ name: "start_on" }] },
  { table: "remote_events", name: "idx_remote_events_visibility", unique: false, columns: [{ name: "visibility" }] },
  {
    table: "outbound_activity_deliveries",
    name: "idx_outbound_deliveries_state_retry",
    unique: false,
    columns: [{ name: "state" }, { name: "next_retry_at" }],
  },
  {
    table: "outbound_activity_deliveries",
    name: "idx_outbound_deliveries_sender",
    unique: false,
    columns: [{ name: "sender_account_id" }],
  },
  {
    table: "outbound_activity_deliveries",
    name: "idx_outbound_deliveries_processing_claimed",
    unique: false,
    columns: [{ name: "state" }, { name: "claimed_at" }],
  },
  {
    table: "processed_inbox_activities",
    name: "idx_processed_inbox_received",
    unique: false,
    columns: [{ name: "received_at" }],
  },
  {
    table: "processed_inbox_activities",
    name: "idx_processed_inbox_status_claimed",
    unique: false,
    columns: [{ name: "status" }, { name: "claimed_at" }],
  },
  {
    table: "remote_following",
    name: "idx_remote_following_account",
    unique: false,
    columns: [{ name: "account_id" }],
  },
  {
    table: "remote_following",
    name: "idx_remote_following_actor_account",
    unique: false,
    columns: [{ name: "actor_uri" }, { name: "account_id" }],
  },
  {
    table: "event_tags",
    name: "idx_event_tags_tag_event_id",
    unique: false,
    columns: [{ name: "tag" }, { name: "event_id" }],
  },
  { table: "event_rsvps", name: "idx_event_rsvps_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "event_rsvps", name: "idx_event_rsvps_event", unique: false, columns: [{ name: "event_uri" }] },
  {
    table: "remote_event_rsvps",
    name: "idx_remote_event_rsvps_event_status",
    unique: false,
    columns: [{ name: "event_id" }, { name: "status" }],
  },
  {
    table: "remote_event_rsvps",
    name: "idx_remote_event_rsvps_actor",
    unique: false,
    columns: [{ name: "actor_uri" }],
  },
  { table: "reposts", name: "idx_reposts_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "reposts", name: "idx_reposts_event", unique: false, columns: [{ name: "event_id" }] },
  { table: "reposts", name: "idx_reposts_event_uri", unique: false, columns: [{ name: "event_uri" }] },
  { table: "auto_reposts", name: "idx_auto_reposts_account", unique: false, columns: [{ name: "account_id" }] },
  { table: "auto_reposts", name: "idx_auto_reposts_source", unique: false, columns: [{ name: "source_account_id" }] },
  { table: "auto_reposts", name: "idx_auto_reposts_source_actor", unique: false, columns: [{ name: "source_actor_uri" }] },
  {
    table: "federation_activity_ids",
    name: "idx_federation_activity_ids_actor_type_object",
    unique: false,
    columns: [{ name: "actor_uri" }, { name: "activity_type" }, { name: "object_uri" }],
  },
  {
    table: "actor_selection_operations",
    name: "idx_actor_selection_ops_initiated_by",
    unique: false,
    columns: [{ name: "initiated_by_account_id" }, { name: "created_at" }],
  },
  {
    table: "actor_selection_operation_items",
    name: "idx_actor_selection_items_operation",
    unique: false,
    columns: [{ name: "operation_id" }],
  },
  {
    table: "saved_locations",
    name: "idx_saved_locations_account",
    unique: false,
    columns: [{ name: "account_id" }, { name: "used_at", desc: true }],
  },
  {
    table: "admin_audit_log",
    name: "idx_admin_audit_created_at",
    unique: false,
    columns: [{ name: "created_at", desc: true }],
  },
  {
    table: "accounts",
    name: "idx_accounts_admin_disabled",
    unique: false,
    columns: [{ name: "is_admin" }, { name: "is_disabled" }],
  },
  {
    table: "events",
    name: "idx_events_moderation_state",
    unique: false,
    columns: [{ name: "moderation_state" }],
  },
  {
    table: "remote_events",
    name: "idx_remote_events_moderation_state",
    unique: false,
    columns: [{ name: "moderation_state" }],
  },
  {
    table: "event_reminder_sent",
    name: "idx_event_reminder_sent_account",
    unique: false,
    columns: [{ name: "account_id" }],
  },
];

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeSqlFragment(fragment: string): string {
  return fragment.replace(/;\s*$/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function extractWhereClause(indexSql: string): string | null {
  const whereMatch = /\bwhere\b([\s\S]*)$/i.exec(indexSql);
  if (!whereMatch) return null;
  const clause = normalizeSqlFragment(whereMatch[1] ?? "");
  return clause.length > 0 ? clause : null;
}

function validateIndexDefinition(db: DB, requiredIndex: RequiredIndex): { ok: boolean; reason?: string } {
  const indexList = db.prepare(`PRAGMA index_list(${quoteIdentifier(requiredIndex.table)})`).all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;

  const indexMeta = indexList.find((row) => row.name === requiredIndex.name);
  if (!indexMeta) {
    return { ok: false, reason: "missing" };
  }

  if (!!indexMeta.unique !== requiredIndex.unique) {
    return {
      ok: false,
      reason: `expected unique=${requiredIndex.unique ? 1 : 0} but found unique=${indexMeta.unique ? 1 : 0}`,
    };
  }

  if (!!requiredIndex.where !== !!indexMeta.partial) {
    return {
      ok: false,
      reason: `expected partial=${requiredIndex.where ? 1 : 0} but found partial=${indexMeta.partial ? 1 : 0}`,
    };
  }

  const indexColumns = db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(requiredIndex.name)})`).all() as Array<{
    seqno: number;
    name: string | null;
    key: number;
    desc: number;
  }>;
  const actualColumns = indexColumns
    .filter((row) => row.key === 1)
    .sort((a, b) => a.seqno - b.seqno)
    .map((row) => ({ name: row.name, desc: !!row.desc }))
    .filter((column): column is { name: string; desc: boolean } => typeof column.name === "string");

  const expectedColumns = requiredIndex.columns.map((column) => ({ name: column.name, desc: !!column.desc }));

  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, idx) => {
      const expected = expectedColumns[idx];
      return !expected || column.name !== expected.name || column.desc !== expected.desc;
    })
  ) {
    const formatColumnList = (columns: Array<{ name: string; desc: boolean }>) =>
      columns.map((column) => `${column.name}${column.desc ? " DESC" : ""}`).join(", ");
    return {
      ok: false,
      reason: `expected columns (${formatColumnList(expectedColumns)}) but found (${formatColumnList(actualColumns)})`,
    };
  }

  if (requiredIndex.where) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ? LIMIT 1")
      .get(requiredIndex.table, requiredIndex.name) as { sql: string | null } | undefined;
    const indexSql = row?.sql;
    if (!indexSql) {
      return { ok: false, reason: "missing index SQL definition in sqlite_master" };
    }
    const actualWhere = extractWhereClause(indexSql);
    const expectedWhere = normalizeSqlFragment(requiredIndex.where);
    if (actualWhere !== expectedWhere) {
      return {
        ok: false,
        reason: `expected WHERE ${requiredIndex.where} but found ${actualWhere ? `WHERE ${actualWhere}` : "none"}`,
      };
    }
  }

  return { ok: true };
}

export function validateMigrationConfiguration(): void {
  const seen = new Set<number>();
  let previousVersion = 0;

  for (const migration of MIGRATIONS) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(
        `Invalid migration configuration: migration "${migration.name}" has version ${migration.version}, expected a positive integer.`
      );
    }
    if (seen.has(migration.version)) {
      throw new Error(`Invalid migration configuration: duplicate migration version ${migration.version}.`);
    }
    if (migration.version <= previousVersion) {
      throw new Error(
        `Invalid migration configuration: migration versions must be strictly increasing; got ${migration.version} after ${previousVersion}.`
      );
    }
    seen.add(migration.version);
    previousVersion = migration.version;
  }

  const expectedCurrentVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (CURRENT_SCHEMA_VERSION !== expectedCurrentVersion) {
    throw new Error(
      `Invalid migration configuration: CURRENT_SCHEMA_VERSION (${CURRENT_SCHEMA_VERSION}) must equal latest migration version (${expectedCurrentVersion}).`
    );
  }
}

validateMigrationConfiguration();

export function validateSchema(db: DB): void {
  const requiredTables = Object.keys(REQUIRED_TABLE_COLUMNS);
  for (const table of requiredTables) {
    if (!hasTable(db, table)) {
      throw new Error(`Database schema validation failed: missing required table "${table}".`);
    }
  }

  const tableColumns = new Map<string, Set<string>>();
  for (const table of requiredTables) {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>;
    tableColumns.set(
      table,
      new Set(rows.map((row) => row.name))
    );
  }

  for (const [table, columns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
    const columnsForTable = tableColumns.get(table) ?? new Set<string>();
    for (const column of columns) {
      if (!columnsForTable.has(column)) {
        throw new Error(`Database schema validation failed: missing required column "${table}.${column}".`);
      }
    }
  }

  for (const index of REQUIRED_INDEXES) {
    const result = validateIndexDefinition(db, index);
    if (!result.ok) {
      throw new Error(
        `Database schema validation failed: invalid required index "${index.name}" on table "${index.table}" (${result.reason}).`
      );
    }
  }
}

function applyPendingMigrations(db: DB, fromVersion: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version <= fromVersion) continue;

    runMigration(db, migration);
  }
}

export function runMigration(db: DB, migration: Migration): void {
  let startedTransaction = false;

  if (migration.disableForeignKeys) {
    db.pragma("foreign_keys = OFF");
  }

  try {
    db.exec("BEGIN");
    startedTransaction = true;
    migration.up(db);
    db.pragma(`user_version = ${migration.version}`);
    db.exec("COMMIT");
  } catch (error) {
    if (startedTransaction) {
      db.exec("ROLLBACK");
    }
    throw new Error(
      `Failed database migration v${migration.version} (${migration.name}): ${toErrorMessage(error, "migration failed")}`
    );
  } finally {
    if (migration.disableForeignKeys) {
      db.pragma("foreign_keys = ON");
    }
  }
}

function validateBaseUrlForPendingMigrations(fromVersion: number): void {
  const isTestEnv = process.env.NODE_ENV === "test";
  const requiresCanonicalRepostMigration = fromVersion < CANONICAL_REPOST_MIGRATION_VERSION;
  if (isTestEnv || !requiresCanonicalRepostMigration) return;

  try {
    validateBaseUrlConfig();
  } catch (error) {
    const detail = toErrorMessage(error, "validation failed");
    throw new Error(
      `BASE_URL preflight check failed before database migrations: ${detail}. Set BASE_URL before starting the server so canonical federation URLs are migrated correctly.`
    );
  }
}

export function initDatabase(path: string): DB {
  const db = new Database(path);
  try {
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
        validateBaseUrlForPendingMigrations(currentVersion);
        applyPendingMigrations(db, 0);
      } else {
        throw new Error(
          `Unsupported unversioned database detected at path "${path}" (user_version=0 with existing tables). Start from an empty database or migrate using a versioned EveryCal database.`
        );
      }
    } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
      validateBaseUrlForPendingMigrations(currentVersion);
      applyPendingMigrations(db, currentVersion);
    }
    validateSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
