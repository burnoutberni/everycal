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

describe("migration canonicalize_synthetic_local_actor_uris", () => {
  const previousBaseUrl = process.env.BASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.BASE_URL = previousBaseUrl;
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("rewrites local.invalid actor URIs to canonical local actor URLs", () => {
    process.env.BASE_URL = "https://everycal.example";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 11);

    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?), (?, ?), (?, ?)").run("reader", "reader", "owner", "alice", "source", "bob");
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("event-1", "owner", "Event", "2026-01-01", "2026-01-01T10:00:00Z", "UTC", "public");

    db.prepare("INSERT INTO auto_reposts (account_id, source_account_id, source_actor_uri) VALUES (?, ?, ?)")
      .run("reader", "source", "https://local.invalid/users/bob");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)")
      .run("reader", "event-1", "event-1", "https://local.invalid/users/alice");

    const migration = MIGRATIONS.find((entry) => entry.version === 12);
    if (!migration) throw new Error("migration 12 not found");
    migration.up(db);

    const autoRow = db.prepare("SELECT source_actor_uri FROM auto_reposts WHERE account_id = ? AND source_account_id = ?")
      .get("reader", "source") as { source_actor_uri: string };
    expect(autoRow.source_actor_uri).toBe("https://everycal.example/users/bob");

    const repostRow = db.prepare("SELECT source_actor_uri FROM reposts WHERE account_id = ? AND event_id = ?")
      .get("reader", "event-1") as { source_actor_uri: string };
    expect(repostRow.source_actor_uri).toBe("https://everycal.example/users/alice");

    db.close();
  });

  it("leaves non-synthetic source actor URIs unchanged", () => {
    process.env.BASE_URL = "https://everycal.example";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 11);

    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?), (?, ?)").run("reader", "reader", "source", "bob");
    db.prepare("INSERT INTO auto_reposts (account_id, source_account_id, source_actor_uri) VALUES (?, ?, ?)")
      .run("reader", "source", "https://remote.example/users/bob");

    const migration = MIGRATIONS.find((entry) => entry.version === 12);
    if (!migration) throw new Error("migration 12 not found");
    migration.up(db);

    const autoRow = db.prepare("SELECT source_actor_uri FROM auto_reposts WHERE account_id = ? AND source_account_id = ?")
      .get("reader", "source") as { source_actor_uri: string };
    expect(autoRow.source_actor_uri).toBe("https://remote.example/users/bob");

    db.close();
  });

  it("throws when BASE_URL is missing outside test env", () => {
    delete process.env.BASE_URL;
    process.env.NODE_ENV = "production";
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 11);

    const migration = MIGRATIONS.find((entry) => entry.version === 12);
    if (!migration) throw new Error("migration 12 not found");

    expect(() => migration.up(db)).toThrow(/BASE_URL must be configured before running migration v12/);

    db.close();
  });
});

describe("migration enforce_local_repost_event_ids", () => {
  it("removes local repost rows missing event_id and keeps remote rows", () => {
    const db = new Database(":memory:");
    applyMigrationsThrough(db, 12);

    db.prepare("INSERT INTO accounts (id, username) VALUES (?, ?), (?, ?) ").run("reader", "reader", "owner", "alice");
    db.prepare("INSERT INTO events (id, account_id, title, start_date, start_at_utc, event_timezone, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("event-1", "owner", "Event", "2026-01-01", "2026-01-01T10:00:00Z", "UTC", "public");

    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)")
      .run("reader", null, "event-1", "https://everycal.example/users/alice");
    db.prepare("INSERT INTO reposts (account_id, event_id, event_uri, source_actor_uri) VALUES (?, ?, ?, ?)")
      .run("reader", null, "https://remote.example/events/1", "https://remote.example/users/alice");

    const migration = MIGRATIONS.find((entry) => entry.version === 13);
    if (!migration) throw new Error("migration 13 not found");
    migration.up(db);

    const localRow = db.prepare("SELECT 1 AS ok FROM reposts WHERE account_id = ? AND event_uri = ?")
      .get("reader", "event-1") as { ok: number } | undefined;
    const remoteRow = db.prepare("SELECT 1 AS ok FROM reposts WHERE account_id = ? AND event_uri = ?")
      .get("reader", "https://remote.example/events/1") as { ok: number } | undefined;

    expect(localRow).toBeUndefined();
    expect(remoteRow?.ok).toBe(1);

    db.close();
  });
});
