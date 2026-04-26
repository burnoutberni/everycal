/**
 * SQLite database initialization and schema management.
 */

import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./db/migrations.js";

export type DB = Database.Database;

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

function hasColumn(db: DB, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function hasIndex(db: DB, indexName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1")
    .get(indexName) as { ok: number } | undefined;
  return !!row?.ok;
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
    if (migration.version <= previousVersion) {
      throw new Error(
        `Invalid migration configuration: migration versions must be strictly increasing; got ${migration.version} after ${previousVersion}.`
      );
    }
    if (seen.has(migration.version)) {
      throw new Error(`Invalid migration configuration: duplicate migration version ${migration.version}.`);
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

export function validateSchema(db: DB): void {
  const requiredTables = ["accounts", "events", "remote_events", "sessions", "api_keys"];
  for (const table of requiredTables) {
    if (!hasTable(db, table)) {
      throw new Error(`Database schema validation failed: missing required table "${table}".`);
    }
  }

  const requiredColumns: Array<{ table: string; column: string }> = [
    { table: "accounts", column: "theme_preference" },
    { table: "events", column: "og_image_url" },
    { table: "remote_events", column: "og_image_url" },
  ];
  for (const { table, column } of requiredColumns) {
    if (!hasColumn(db, table, column)) {
      throw new Error(`Database schema validation failed: missing required column "${table}.${column}".`);
    }
  }

  const requiredIndexes = ["idx_events_slug", "idx_remote_events_actor_slug"];
  for (const index of requiredIndexes) {
    if (!hasIndex(db, index)) {
      throw new Error(`Database schema validation failed: missing required index "${index}".`);
    }
  }
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

export function initDatabase(path: string): DB {
  const db = new Database(path);
  try {
    validateMigrationConfiguration();

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
        throw new Error(
          "Unsupported unversioned database detected (user_version=0 with existing tables). Start from an empty database or migrate using a versioned EveryCal database."
        );
      }
    } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
      applyPendingMigrations(db, currentVersion);
    }
    validateSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
