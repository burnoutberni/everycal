import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../src/db/migrations.js";

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
    const baselineMigration = MIGRATIONS.find((migration) => migration.version === 1);
    if (!baselineMigration) {
      throw new Error("Missing baseline migration");
    }
    baselineMigration.up(versioned);
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
    const initialized = initDatabase(dbPath);
    initialized.close();
    const db = new Database(dbPath);
    db.exec("ALTER TABLE events DROP COLUMN og_image_url");
    db.close();

    expect(() => initDatabase(dbPath)).toThrow(/missing required column "events.og_image_url"/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails startup when a required schema index is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "missing-index.sqlite");
    const initialized = initDatabase(dbPath);
    initialized.close();
    const db = new Database(dbPath);
    db.exec("DROP INDEX idx_remote_events_actor_slug");
    db.close();

    expect(() => initDatabase(dbPath)).toThrow(/invalid required index "idx_remote_events_actor_slug".*\(missing\)/);
    rmSync(dir, { recursive: true, force: true });
  });
});
