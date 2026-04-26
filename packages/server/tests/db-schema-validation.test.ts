import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { validateSchema, type DB } from "../src/db.js";
import { MIGRATIONS } from "../src/db/migrations.js";

function createBaseSchema(db: DB): void {
  for (const migration of MIGRATIONS) {
    migration.up(db);
  }
}

describe("schema index definition validation", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
  });

  it("accepts required indexes when definitions match", () => {
    db = new Database(":memory:");
    createBaseSchema(db);

    expect(() => validateSchema(db)).not.toThrow();
  });

  it("rejects required index when unique flag drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_events_slug;
      CREATE INDEX idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
    `);

    expect(() => validateSchema(db)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db)).toThrow(/expected unique=1 but found unique=0/);
  });

  it("rejects required index when column order drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_events_slug;
      CREATE UNIQUE INDEX idx_events_slug ON events(slug, account_id) WHERE slug IS NOT NULL;
    `);

    expect(() => validateSchema(db)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db)).toThrow(/expected columns \(account_id, slug\) but found \(slug, account_id\)/);
  });

  it("rejects required index when WHERE predicate drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_events_slug;
      CREATE UNIQUE INDEX idx_events_slug ON events(account_id, slug);
    `);

    expect(() => validateSchema(db)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db)).toThrow(/expected partial=1 but found partial=0/);
  });

  it("rejects required columns when schema drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec("ALTER TABLE remote_events DROP COLUMN title;");

    expect(() => validateSchema(db)).toThrow(/missing required column "remote_events.title"/);
  });

  it("rejects required index when sort order drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      DROP INDEX idx_saved_locations_account;
      CREATE INDEX idx_saved_locations_account ON saved_locations(account_id, used_at);
    `);

    expect(() => validateSchema(db)).toThrow(/invalid required index "idx_saved_locations_account"/);
    expect(() => validateSchema(db)).toThrow(/expected columns \(account_id, used_at DESC\) but found \(account_id, used_at\)/);
  });
});
