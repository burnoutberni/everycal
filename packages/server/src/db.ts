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
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    }
  } else if (currentVersion < CURRENT_SCHEMA_VERSION) {
    applyPendingMigrations(db, currentVersion);
  }
  return db;
}
