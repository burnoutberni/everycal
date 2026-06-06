import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, validateSchema, type DB } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../src/db/migrations.js";

function createBaseSchema(db: DB): void {
  for (const migration of MIGRATIONS) {
    migration.up(db);
  }
}

describe("schema index definition validation", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("accepts required indexes when definitions match", () => {
    db = new Database(":memory:");
    createBaseSchema(db);

    expect(() => validateSchema(db!)).not.toThrow();
  });

  it("rejects required index when unique flag drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_events_slug;
      CREATE INDEX idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
    `);

    expect(() => validateSchema(db!)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db!)).toThrow(/expected unique=1 but found unique=0/);
  });

  it("rejects required index when column order drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_events_slug;
      CREATE UNIQUE INDEX idx_events_slug ON events(slug, account_id) WHERE slug IS NOT NULL;
    `);

    expect(() => validateSchema(db!)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db!)).toThrow(/expected columns \(account_id, slug\) but found \(slug, account_id\)/);
  });

  it("rejects required index when WHERE predicate drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_events_slug;
      CREATE UNIQUE INDEX idx_events_slug ON events(account_id, slug);
    `);

    expect(() => validateSchema(db!)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db!)).toThrow(/expected partial=1 but found partial=0/);
  });

  it("rejects required columns when schema drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec("ALTER TABLE remote_events DROP COLUMN title;");

    expect(() => validateSchema(db!)).toThrow(/missing required column "remote_events.title"/);
  });

  it("rejects required index when sort order drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_saved_locations_account;
      CREATE INDEX idx_saved_locations_account ON saved_locations(account_id, used_at);
    `);

    expect(() => validateSchema(db!)).toThrow(/invalid required index "idx_saved_locations_account"/);
    expect(() => validateSchema(db!)).toThrow(/expected columns \(account_id, used_at DESC\) but found \(account_id, used_at\)/);
  });
});

describe("database schema validation", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createDbPath(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-schema-"));
    tempDirs.push(dir);
    return join(dir, `${name}.sqlite`);
  }

  function withInitializedDatabase(name: string, mutate: (db: Database.Database) => void): string {
    const dbPath = createDbPath(name);
    const db = initDatabase(dbPath);
    db.close();

    const rawDb = new Database(dbPath);
    rawDb.pragma("foreign_keys = OFF");
    mutate(rawDb);
    rawDb.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    rawDb.close();

    return dbPath;
  }

  it("rejects a persisted database missing an admin table", () => {
    const dbPath = withInitializedDatabase("missing-admin-table", (db) => {
      db.exec("DROP TABLE admin_job_runs");
    });

    expect(() => initDatabase(dbPath)).toThrow(
      'Database schema validation failed: missing required table "admin_job_runs".'
    );
  });

  it("rejects a persisted database missing the federation block reason column", () => {
    const dbPath = withInitializedDatabase("missing-federation-block-reason", (db) => {
      db.exec("ALTER TABLE federation_blocks RENAME TO federation_blocks_old");
      db.exec(
        "CREATE TABLE federation_blocks (id TEXT PRIMARY KEY, block_type TEXT NOT NULL CHECK(block_type IN ('actor','domain')), actor_uri TEXT, domain TEXT, created_by_account_id TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
      );
      db.exec(
        "INSERT INTO federation_blocks (id, block_type, actor_uri, domain, created_by_account_id, is_active, created_at) SELECT id, block_type, actor_uri, domain, created_by_account_id, is_active, created_at FROM federation_blocks_old"
      );
      db.exec("DROP TABLE federation_blocks_old");
    });

    expect(() => initDatabase(dbPath)).toThrow(
      'Database schema validation failed: missing required column "federation_blocks.reason".'
    );
  });

  it("rejects a persisted database missing an admin index", () => {
    const dbPath = withInitializedDatabase("missing-admin-index", (db) => {
      db.exec("DROP INDEX idx_admin_audit_created_at");
    });

    expect(() => initDatabase(dbPath)).toThrow(
      'Database schema validation failed: invalid required index "idx_admin_audit_created_at" on table "admin_audit_log" (missing).'
    );
  });
});
