import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../src/db/migrations.js";
import type { DB } from "../src/db.js";

function applyMigrationsThrough(db: DB, maxVersion: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > maxVersion) break;
    migration.up(db);
  }
}

function recreateLegacyRepostTables(db: DB): void {
  db.exec("DROP TABLE reposts");
  db.exec("DROP TABLE auto_reposts");
  db.exec(`CREATE TABLE reposts (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, event_id)
  )`);
  db.exec(`CREATE TABLE auto_reposts (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    source_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, source_account_id)
  )`);
}

describe("migration universal_reposts_canonicalization", () => {
  const previousBaseUrl = process.env.BASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.BASE_URL = previousBaseUrl;
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("rewrites local repost fields to canonical URLs and keeps remote URIs", () => {
    process.env.BASE_URL = "https://everycal.example";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 9);
    recreateLegacyRepostTables(db);

    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?), (?, ?), (?, ?)").run("reader", "reader", "owner", "alice", "source", "bob");
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("event-1", "owner", "Event", "2026-01-01", "2026-01-01T10:00:00Z", "UTC", "public");

    db.prepare("INSERT INTO reposts (account_id, event_id, created_at) VALUES (?, ?, ?)")
      .run("reader", "event-1", "2026-01-01T00:00:00Z");
    db.prepare("INSERT INTO auto_reposts (account_id, source_account_id, created_at) VALUES (?, ?, ?)")
      .run("reader", "source", "2026-01-01T00:00:00Z");

    const migration = MIGRATIONS.find((entry) => entry.version === 10);
    if (!migration) throw new Error("migration 10 not found");
    migration.up(db);

    const repostRow = db.prepare("SELECT event_uri, source_actor_uri FROM reposts WHERE account_id = ? AND event_id = ?")
      .get("reader", "event-1") as { event_uri: string; source_actor_uri: string };
    const autoRow = db.prepare("SELECT source_actor_uri FROM auto_reposts WHERE account_id = ? AND source_account_id = ?")
      .get("reader", "source") as { source_actor_uri: string };

    expect(repostRow.event_uri).toBe("https://everycal.example/events/event-1");
    expect(repostRow.source_actor_uri).toBe("https://everycal.example/users/alice");
    expect(autoRow.source_actor_uri).toBe("https://everycal.example/users/bob");

    db.close();
  });

  it("does not fail when source_account_id is NULL or missing", () => {
    process.env.BASE_URL = "https://everycal.example";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 9);
    recreateLegacyRepostTables(db);

    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("reader", "reader");
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO auto_reposts (account_id, source_account_id, created_at) VALUES (?, ?, ?)")
      .run("reader", null, "2026-01-01T00:00:00Z");
    db.prepare("INSERT INTO auto_reposts (account_id, source_account_id, created_at) VALUES (?, ?, ?)")
      .run("reader", "missing", "2026-01-02T00:00:00Z");
    db.exec("PRAGMA foreign_keys = ON");

    const migration = MIGRATIONS.find((entry) => entry.version === 10);
    if (!migration) throw new Error("migration 10 not found");
    migration.up(db);

    const rows = db.prepare("SELECT source_actor_uri FROM auto_reposts WHERE account_id = ? ORDER BY created_at ASC")
      .all("reader") as Array<{ source_actor_uri: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].source_actor_uri.startsWith("https://local.invalid/users/deleted-")).toBe(true);
    expect(rows[1].source_actor_uri).toBe("https://local.invalid/users/deleted-missing");

    db.close();
  });

  it("deduplicates repost PK collisions created by canonical event_uri rewrite", () => {
    process.env.BASE_URL = "https://everycal.example";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 9);
    db.exec("DROP TABLE reposts");
    db.exec(`CREATE TABLE reposts (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
      event_uri TEXT NOT NULL,
      source_actor_uri TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, event_uri)
    )`);

    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?), (?, ?)").run("reader", "reader", "owner", "alice");
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("event-1", "owner", "Event", "2026-01-01", "2026-01-01T10:00:00Z", "UTC", "public");

    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("reader", "event-1", "event-1", "https://local.invalid/users/alice", "2026-01-01T00:00:00Z");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("reader", "event-1", "https://everycal.example/events/event-1", "https://everycal.example/users/alice", "2026-01-02T00:00:00Z");

    const migration = MIGRATIONS.find((entry) => entry.version === 10);
    if (!migration) throw new Error("migration 10 not found");
    migration.up(db);

    const rows = db.prepare("SELECT event_uri FROM reposts WHERE account_id = ? AND event_id = ?")
      .all("reader", "event-1") as Array<{ event_uri: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_uri).toBe("https://everycal.example/events/event-1");

    db.close();
  });

  it("skips legacy repost rows with empty canonical event_uri", () => {
    process.env.BASE_URL = "https://everycal.example";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 9);
    db.exec("DROP TABLE reposts");
    db.exec(`CREATE TABLE reposts (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
      event_uri TEXT NOT NULL,
      source_actor_uri TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, event_uri)
    )`);

    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?), (?, ?)").run("reader", "reader", "owner", "alice");
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("event-1", "owner", "Event", "2026-01-01", "2026-01-01T10:00:00Z", "UTC", "public");

    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("reader", null, "", null, "2026-01-01T00:00:00Z");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("reader", "event-1", "legacy-event-id", null, "2026-01-02T00:00:00Z");

    const migration = MIGRATIONS.find((entry) => entry.version === 10);
    if (!migration) throw new Error("migration 10 not found");
    migration.up(db);

    const rows = db.prepare("SELECT event_id, event_uri FROM reposts WHERE account_id = ? ORDER BY created_at ASC")
      .all("reader") as Array<{ event_id: string | null; event_uri: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe("event-1");
    expect(rows[0].event_uri).toBe("https://everycal.example/events/event-1");

    db.close();
  });

  it("throws when BASE_URL is missing outside test env", () => {
    delete process.env.BASE_URL;
    process.env.NODE_ENV = "production";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 9);

    const migration = MIGRATIONS.find((entry) => entry.version === 10);
    if (!migration) throw new Error("migration 10 not found");

    expect(() => migration.up(db)).toThrow(/BASE_URL must be configured before running migration v10/);

    db.close();
  });
});
