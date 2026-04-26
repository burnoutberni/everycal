import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/migrations.js";

describe("account timezone/locale defaults", () => {
  it("defaults new accounts to system timezone, locale, and theme", () => {
    const db = initDatabase(":memory:");
    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u1", "user1");
    const row = db.prepare("SELECT timezone, date_time_locale, theme_preference FROM accounts WHERE id = ?").get("u1") as {
      timezone: string;
      date_time_locale: string;
      theme_preference: string;
    };

    expect(row.timezone).toBe("system");
    expect(row.date_time_locale).toBe("system");
    expect(row.theme_preference).toBe("system");
  });

  it("initializes a fresh empty database to the current schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "fresh.sqlite");
    const db = initDatabase(dbPath);
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects unversioned non-empty legacy schemas", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        timezone TEXT,
        date_time_locale TEXT
      );
    `);
    legacy.close();

    expect(() => initDatabase(dbPath)).toThrow(/Unsupported unversioned database detected/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a versioned database forward to current schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "versioned-old.sqlite");
    const versioned = new Database(dbPath);
    versioned.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        timezone TEXT NOT NULL DEFAULT 'system',
        date_time_locale TEXT NOT NULL DEFAULT 'system',
        theme_preference TEXT NOT NULL DEFAULT 'system'
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        last_used_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        key_prefix TEXT
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        slug TEXT,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_at_utc TEXT NOT NULL,
        event_timezone TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'public',
        og_image_url TEXT
      );
      CREATE TABLE remote_events (
        uri TEXT PRIMARY KEY,
        actor_uri TEXT NOT NULL,
        slug TEXT,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_at_utc TEXT NOT NULL,
        timezone_quality TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
      CREATE UNIQUE INDEX idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL;
    `);
    versioned.pragma("user_version = 1");
    versioned.close();

    const reopened = initDatabase(dbPath);
    const userVersion = reopened.pragma("user_version", { simple: true }) as number;
    expect(userVersion).toBe(CURRENT_SCHEMA_VERSION);
    const columns = reopened.prepare("PRAGMA table_info(remote_events)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "og_image_url")).toBe(true);
    reopened.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("fails startup when a required schema column is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "missing-column.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, theme_preference TEXT NOT NULL);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, key_hash TEXT NOT NULL);
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        slug TEXT,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_at_utc TEXT NOT NULL,
        event_timezone TEXT NOT NULL
      );
      CREATE TABLE remote_events (
        uri TEXT PRIMARY KEY,
        actor_uri TEXT NOT NULL,
        slug TEXT,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_at_utc TEXT NOT NULL,
        timezone_quality TEXT NOT NULL,
        og_image_url TEXT
      );
      CREATE UNIQUE INDEX idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
      CREATE UNIQUE INDEX idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL;
    `);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.close();

    expect(() => initDatabase(dbPath)).toThrow(/missing required column "events.og_image_url"/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails startup when a required schema index is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "missing-index.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, theme_preference TEXT NOT NULL);
      CREATE TABLE sessions (token TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, key_hash TEXT NOT NULL);
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        slug TEXT,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_at_utc TEXT NOT NULL,
        event_timezone TEXT NOT NULL,
        og_image_url TEXT
      );
      CREATE TABLE remote_events (
        uri TEXT PRIMARY KEY,
        actor_uri TEXT NOT NULL,
        slug TEXT,
        title TEXT NOT NULL,
        start_date TEXT NOT NULL,
        start_at_utc TEXT NOT NULL,
        timezone_quality TEXT NOT NULL,
        og_image_url TEXT
      );
      CREATE UNIQUE INDEX idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
    `);
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.close();

    expect(() => initDatabase(dbPath)).toThrow(/invalid required index "idx_remote_events_actor_slug".*\(missing\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});
