import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { validateSchema, type DB } from "../src/db.js";

function createBaseSchema(db: DB): void {
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, theme_preference TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, account_id TEXT, slug TEXT, og_image_url TEXT);
    CREATE TABLE remote_events (uri TEXT PRIMARY KEY, actor_uri TEXT, slug TEXT, og_image_url TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id TEXT, expires_at TEXT);
    CREATE TABLE api_keys (id TEXT PRIMARY KEY, account_id TEXT, key_hash TEXT, key_prefix TEXT);
  `);
}

function createRequiredIndexes(db: DB): void {
  db.exec(`
    CREATE UNIQUE INDEX idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
    CREATE UNIQUE INDEX idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL;
  `);
}

describe("schema index definition validation", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
  });

  it("accepts required indexes when definitions match", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    createRequiredIndexes(db);

    expect(() => validateSchema(db)).not.toThrow();
  });

  it("rejects required index when unique flag drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      CREATE INDEX idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
      CREATE UNIQUE INDEX idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL;
    `);

    expect(() => validateSchema(db)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db)).toThrow(/expected unique=1 but found unique=0/);
  });

  it("rejects required index when column order drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      CREATE UNIQUE INDEX idx_events_slug ON events(slug, account_id) WHERE slug IS NOT NULL;
      CREATE UNIQUE INDEX idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL;
    `);

    expect(() => validateSchema(db)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db)).toThrow(/expected columns \(account_id, slug\) but found \(slug, account_id\)/);
  });

  it("rejects required index when WHERE predicate drifts", () => {
    db = new Database(":memory:");
    createBaseSchema(db);
    db.exec(`
      CREATE UNIQUE INDEX idx_events_slug ON events(account_id, slug);
      CREATE UNIQUE INDEX idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL;
    `);

    expect(() => validateSchema(db)).toThrow(/invalid required index "idx_events_slug"/);
    expect(() => validateSchema(db)).toThrow(/expected partial=1 but found partial=0/);
  });

  it("rejects required key columns when schema drifts", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, theme_preference TEXT);
      CREATE TABLE events (id TEXT PRIMARY KEY, account_id TEXT, slug TEXT, og_image_url TEXT);
      CREATE TABLE remote_events (id TEXT PRIMARY KEY, actor_uri TEXT, slug TEXT, og_image_url TEXT);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id TEXT, expires_at TEXT);
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, account_id TEXT, key_hash TEXT, key_prefix TEXT);
    `);
    createRequiredIndexes(db);

    expect(() => validateSchema(db)).toThrow(/missing required column "remote_events.uri"/);
  });
});
