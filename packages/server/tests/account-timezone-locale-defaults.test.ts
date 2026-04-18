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

  it("adopts the schema version marker for already-current schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "current.sqlite");
    const initial = initDatabase(dbPath);
    initial.pragma("user_version = 0");
    initial.close();

    const reopened = initDatabase(dbPath);
    const userVersion = reopened.pragma("user_version", { simple: true }) as number;
    expect(userVersion).toBe(1);

    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects unsupported legacy account schemas", () => {
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

    expect(() => initDatabase(dbPath)).toThrow(/Unsupported legacy database schema/i);

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects calendar_feed_tokens schemas missing token column", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy-calendar-feed-tokens.sqlite");
    const db = initDatabase(dbPath);
    db.exec(`
      CREATE TABLE calendar_feed_tokens_new (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO calendar_feed_tokens_new (account_id, token_hash, created_at)
      SELECT account_id, token, created_at FROM calendar_feed_tokens;
      DROP TABLE calendar_feed_tokens;
      ALTER TABLE calendar_feed_tokens_new RENAME TO calendar_feed_tokens;
    `);
    db.close();

    expect(() => initDatabase(dbPath)).toThrow(/Unsupported legacy database schema/i);

    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects event_rsvps data containing legacy statuses", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy-event-rsvps-status.sqlite");
    const db = initDatabase(dbPath);
    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u1", "user1");
    db.exec(`
      CREATE TABLE event_rsvps_new (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        event_uri TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, event_uri)
      );
      DROP TABLE event_rsvps;
      ALTER TABLE event_rsvps_new RENAME TO event_rsvps;
    `);
    db.prepare("INSERT INTO event_rsvps (account_id, event_uri, status) VALUES (?, ?, ?)")
      .run("u1", "event:1", "interested");
    db.close();

    expect(() => initDatabase(dbPath)).toThrow(/Unsupported legacy database schema/i);

    rmSync(dir, { recursive: true, force: true });
  });
});
