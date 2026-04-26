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

type RequiredIndex = {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
  where?: string;
};

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
  }>;
  const actualColumns = indexColumns
    .filter((row) => row.key === 1)
    .sort((a, b) => a.seqno - b.seqno)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");

  if (
    actualColumns.length !== requiredIndex.columns.length ||
    actualColumns.some((column, idx) => column !== requiredIndex.columns[idx])
  ) {
    return {
      ok: false,
      reason: `expected columns (${requiredIndex.columns.join(", ")}) but found (${actualColumns.join(", ")})`,
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

  const requiredIndexes: RequiredIndex[] = [
    {
      table: "events",
      name: "idx_events_slug",
      unique: true,
      columns: ["account_id", "slug"],
      where: "slug IS NOT NULL",
    },
    {
      table: "remote_events",
      name: "idx_remote_events_actor_slug",
      unique: true,
      columns: ["actor_uri", "slug"],
      where: "slug IS NOT NULL",
    },
  ];
  for (const index of requiredIndexes) {
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
