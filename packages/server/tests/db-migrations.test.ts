import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase, runMigration, type DB } from "../src/db.js";
import type { Migration } from "../src/db/migrations.js";

function createDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `everycal-db-migrations-${name}-`));
  tempDirs.push(dir);
  return join(dir, `${name}.sqlite`);
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runMigration", () => {
  let db: DB | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("disables foreign keys before entering rebuild migrations and restores them after commit", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent(id)
      );
      INSERT INTO parent (id) VALUES ('parent-1');
      INSERT INTO child (id, parent_id) VALUES ('child-1', 'parent-1');
    `);

    let observedForeignKeys = -1;
    const migration: Migration = {
      version: 1,
      name: "rebuild_parent",
      disableForeignKeys: true,
      up: (migrationDb) => {
        observedForeignKeys = migrationDb.pragma("foreign_keys", { simple: true }) as number;
        migrationDb.exec(`
          CREATE TABLE parent_new (id TEXT PRIMARY KEY);
          INSERT INTO parent_new (id) SELECT id FROM parent;
          DROP TABLE parent;
          ALTER TABLE parent_new RENAME TO parent;
        `);
      },
    };

    expect(() => runMigration(db!, migration)).not.toThrow();
    expect(observedForeignKeys).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(() => db!.prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)").run("child-2", "missing")).toThrow();
    expect(db.prepare("SELECT parent_id FROM child WHERE id = ?").get("child-1")).toEqual({ parent_id: "parent-1" });
  });

  it("restores foreign keys and rolls back partial changes when a rebuild migration fails", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");

    let observedForeignKeys = -1;
    const migration: Migration = {
      version: 1,
      name: "failing_rebuild",
      disableForeignKeys: true,
      up: (migrationDb) => {
        observedForeignKeys = migrationDb.pragma("foreign_keys", { simple: true }) as number;
        migrationDb.exec("CREATE TABLE parent_new (id TEXT PRIMARY KEY)");
        throw new Error("boom");
      },
    };

    expect(() => runMigration(db!, migration)).toThrow(
      "Failed database migration v1 (failing_rebuild): boom"
    );
    expect(observedForeignKeys).toBe(0);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("parent_new")
    ).toBeUndefined();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("parent")
    ).toEqual({ name: "parent" });
  });

  it("restores foreign keys and wraps errors when BEGIN fails before the transaction starts", () => {
    const calls: string[] = [];
    let foreignKeysEnabled = true;
    const dbStub = {
      pragma: (sql: string, options?: { simple?: boolean }) => {
        calls.push(`pragma:${sql}`);
        if (sql === "foreign_keys = OFF") {
          foreignKeysEnabled = false;
          return;
        }
        if (sql === "foreign_keys = ON") {
          foreignKeysEnabled = true;
          return;
        }
        if (sql === "foreign_keys" && options?.simple) {
          return foreignKeysEnabled ? 1 : 0;
        }
        return undefined;
      },
      exec: (sql: string) => {
        calls.push(`exec:${sql}`);
        if (sql === "BEGIN") {
          throw new Error("cannot start transaction");
        }
      },
    } as unknown as DB;

    const migration: Migration = {
      version: 1,
      name: "begin_failure",
      disableForeignKeys: true,
      up: () => {
        throw new Error("should not run");
      },
    };

    expect(() => runMigration(dbStub, migration)).toThrow(
      "Failed database migration v1 (begin_failure): cannot start transaction"
    );
    expect(foreignKeysEnabled).toBe(true);
    expect(calls).toEqual([
      "pragma:foreign_keys = OFF",
      "exec:BEGIN",
      "pragma:foreign_keys = ON",
    ]);
  });
});

describe("v18 oidc_sso_v1 migration", () => {
  it("upgrades a version 17 database with account foreign key dependents", () => {
    const dbPath = createDbPath("accounts-v18-upgrade");
    const db = initDatabase(dbPath);
    db.prepare(
      `INSERT INTO accounts (
        id, username, timezone, date_time_locale, theme_preference, default_event_visibility, city, city_lat, city_lng
      ) VALUES (?, ?, 'system', 'system', 'system', 'public', ?, ?, ?)`
    ).run("acct-1", "alice", "Paris", 48.8566, 2.3522);
    db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)").run(
      "session-1",
      "acct-1",
      "2099-01-01T00:00:00Z"
    );
    db.close();

    const rawDb = new Database(dbPath);
    rawDb.pragma("foreign_keys = OFF");
    rawDb.exec(`
      DROP TABLE account_auth_identities;
      DROP TABLE account_role_assignments;
      DROP TABLE oidc_login_states;

      CREATE TABLE accounts_v17 (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        account_type TEXT NOT NULL DEFAULT 'person' CHECK(account_type IN ('person','identity')),
        display_name TEXT,
        bio TEXT,
        avatar_url TEXT,
        password_hash TEXT,
        private_key TEXT,
        public_key TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        discoverable INTEGER NOT NULL DEFAULT 0,
        timezone TEXT NOT NULL DEFAULT 'system',
        date_time_locale TEXT NOT NULL DEFAULT 'system',
        theme_preference TEXT NOT NULL DEFAULT 'system' CHECK(theme_preference IN ('system','light','dark')),
        default_event_visibility TEXT NOT NULL DEFAULT 'public' CHECK(default_event_visibility IN ('public','unlisted','followers_only','private')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        website TEXT,
        city TEXT NOT NULL,
        city_lat REAL NOT NULL,
        city_lng REAL NOT NULL,
        email TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        email_verified_at TEXT,
        preferred_language TEXT DEFAULT 'en',
        calendar_feed_token_version INTEGER NOT NULL DEFAULT 1,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_disabled INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO accounts_v17 (
        id, username, account_type, display_name, bio, avatar_url, password_hash, private_key, public_key,
        is_bot, discoverable, timezone, date_time_locale, theme_preference, default_event_visibility,
        created_at, updated_at, website, city, city_lat, city_lng, email, email_verified, email_verified_at,
        preferred_language, calendar_feed_token_version, is_admin, is_disabled
      )
      SELECT
        id, username, account_type, display_name, bio, avatar_url, password_hash, private_key, public_key,
        is_bot, discoverable, timezone, date_time_locale, theme_preference, default_event_visibility,
        created_at, updated_at, website, city, city_lat, city_lng, email, email_verified, email_verified_at,
        preferred_language, calendar_feed_token_version, is_admin, is_disabled
      FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_v17 RENAME TO accounts;

      CREATE TABLE sessions_v17 (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      );
      INSERT INTO sessions_v17 (token, account_id, created_at, expires_at)
      SELECT token, account_id, created_at, expires_at FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_v17 RENAME TO sessions;
      CREATE INDEX idx_sessions_account ON sessions(account_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);
    `);
    rawDb.pragma("user_version = 17");
    rawDb.close();

    const migratedDb = initDatabase(dbPath);
    const cityColumns = migratedDb
      .prepare("PRAGMA table_info(accounts)")
      .all() as Array<{ name: string; notnull: number }>;

    expect(
      cityColumns
        .filter((column) => ["city", "city_lat", "city_lng"].includes(column.name))
        .map((column) => ({ name: column.name, notnull: column.notnull }))
    ).toEqual([
      { name: "city", notnull: 0 },
      { name: "city_lat", notnull: 0 },
      { name: "city_lng", notnull: 0 },
    ]);
    const sessionColumns = migratedDb
      .prepare("PRAGMA table_info(sessions)")
      .all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
    expect(sessionColumns.find((column) => column.name === "auth_method")).toMatchObject({
      notnull: 1,
      dflt_value: "'local'",
    });
    expect(migratedDb.prepare("SELECT account_id FROM sessions WHERE token = ?").get("session-1")).toEqual({
      account_id: "acct-1",
    });
    expect(migratedDb.prepare("SELECT auth_method FROM sessions WHERE token = ?").get("session-1")).toEqual({
      auth_method: "local",
    });
    expect(
      () => migratedDb.prepare("INSERT INTO sessions (token, account_id, expires_at, auth_method) VALUES (?, ?, ?, ?)").run(
        "session-2",
        "missing-account",
        "2099-01-02T00:00:00Z",
        "local"
      )
    ).toThrow();

    migratedDb.close();
  });
});
