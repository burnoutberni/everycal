import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../src/db.js";

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

  it("backfills null legacy account timezone/locale to system", () => {
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
    legacy.prepare("INSERT INTO accounts (id, username, timezone, date_time_locale) VALUES (?, ?, ?, ?)")
      .run("u1", "user1", null, null);
    legacy.close();

    const migrated = initDatabase(dbPath);
    const row = migrated.prepare("SELECT timezone, date_time_locale FROM accounts WHERE id = ?").get("u1") as {
      timezone: string;
      date_time_locale: string;
    };

    expect(row.timezone).toBe("system");
    expect(row.date_time_locale).toBe("system");

    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves explicit legacy timezone/locale values", () => {
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
    legacy.prepare("INSERT INTO accounts (id, username, timezone, date_time_locale) VALUES (?, ?, ?, ?)")
      .run("u1", "user1", "Europe/Vienna", "en-GB");
    legacy.close();

    const migrated = initDatabase(dbPath);
    const row = migrated.prepare("SELECT timezone, date_time_locale FROM accounts WHERE id = ?").get("u1") as {
      timezone: string;
      date_time_locale: string;
    };

    expect(row.timezone).toBe("Europe/Vienna");
    expect(row.date_time_locale).toBe("en-GB");

    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes legacy column defaults for future inserts", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        account_type TEXT NOT NULL DEFAULT 'person',
        display_name TEXT,
        bio TEXT,
        avatar_url TEXT,
        password_hash TEXT,
        private_key TEXT,
        public_key TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        discoverable INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL DEFAULT 'Europe/Vienna',
        date_time_locale TEXT NOT NULL DEFAULT 'en-GB',
        default_event_visibility TEXT NOT NULL DEFAULT 'public',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        website TEXT,
        city TEXT NOT NULL DEFAULT 'Wien',
        city_lat REAL NOT NULL DEFAULT 48.2082,
        city_lng REAL NOT NULL DEFAULT 16.3738,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        email_verified_at TEXT,
        preferred_language TEXT DEFAULT 'en'
      );
    `);
    legacy.close();

    const migrated = initDatabase(dbPath);
    migrated.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u2", "user2");
    const row = migrated.prepare("SELECT timezone, date_time_locale FROM accounts WHERE id = ?").get("u2") as {
      timezone: string;
      date_time_locale: string;
    };

    expect(row.timezone).toBe("system");
    expect(row.date_time_locale).toBe("system");

    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
