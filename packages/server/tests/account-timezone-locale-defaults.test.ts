import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../src/db/migrations.js";
import { hashTokenSecret } from "../src/lib/token-secrets.js";

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

  it("normalizes legacy ISO expiry timestamps during migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy-token-expiry.sqlite");
    const versioned = new Database(dbPath);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 3)) {
      migration.up(versioned);
    }

    versioned.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u-token", "u_token");
    versioned
      .prepare("INSERT INTO email_verification_tokens (account_id, token, expires_at) VALUES (?, ?, ?)")
      .run("u-token", "verify-token", "2026-04-27T09:30:00.000Z");
    versioned
      .prepare("INSERT INTO password_reset_tokens (account_id, token, expires_at) VALUES (?, ?, ?)")
      .run("u-token", hashTokenSecret("reset-token"), "2026-04-27T09:30:00.000Z");
    versioned
      .prepare("INSERT INTO email_change_requests (account_id, new_email, token, expires_at) VALUES (?, ?, ?, ?)")
      .run("u-token", "updated@example.com", hashTokenSecret("change-token"), "2026-04-27T09:30:00.000Z");
    versioned
      .prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)")
      .run("session-token", "u-token", "2026-04-27T09:30:00.000Z");
    versioned.pragma("user_version = 3");
    versioned.close();

    const reopened = initDatabase(dbPath);
    const verification = reopened.prepare("SELECT expires_at FROM email_verification_tokens WHERE account_id = ?").get("u-token") as {
      expires_at: string;
    };
    const reset = reopened.prepare("SELECT expires_at FROM password_reset_tokens WHERE account_id = ?").get("u-token") as {
      expires_at: string;
    };
    const change = reopened.prepare("SELECT expires_at FROM email_change_requests WHERE account_id = ?").get("u-token") as {
      expires_at: string;
    };
    const session = reopened.prepare("SELECT expires_at FROM sessions WHERE account_id = ?").get("u-token") as {
      expires_at: string;
    };

    expect(verification.expires_at).toBe("2026-04-27 09:30:00");
    expect(reset.expires_at).toBe("2026-04-27 09:30:00");
    expect(change.expires_at).toBe("2026-04-27 09:30:00");
    expect(session.expires_at).toBe("2026-04-27 09:30:00");
    reopened.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes outbound retry timestamps during migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy-outbound-retry.sqlite");
    const versioned = new Database(dbPath);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 7)) {
      migration.up(versioned);
    }

    versioned.exec(`CREATE TABLE outbound_activity_deliveries (
      id TEXT PRIMARY KEY,
      destination_inbox TEXT NOT NULL,
      sender_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      sender_actor_uri TEXT NOT NULL,
      sender_key_id TEXT,
      activity_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','delivered','failed')),
      claimed_at TEXT,
      worker_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    versioned.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u-outbound", "u_outbound");
    const insertDelivery = versioned.prepare(
      "INSERT INTO outbound_activity_deliveries (id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json, next_retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insertDelivery.run(
      "delivery-1",
      "https://remote.example/inbox",
      "u-outbound",
      "http://localhost:3000/users/u_outbound",
      "https://keys.local.example/u_outbound#rotated-v2",
      '{"id":"https://example.test/activities/1","type":"Create"}',
      "2026-04-27T09:30:00.000Z"
    );
    insertDelivery.run(
      "delivery-2",
      "https://remote.example/inbox",
      "u-outbound",
      "http://localhost:3000/users/u_outbound",
      "",
      '{"id":"https://example.test/activities/2","type":"Create"}',
      ""
    );
    versioned.pragma("user_version = 7");
    versioned.close();

    const reopened = initDatabase(dbPath);
    const row = reopened.prepare("SELECT next_retry_at, sender_key_id FROM outbound_activity_deliveries WHERE id = ?").get("delivery-1") as {
      next_retry_at: string;
      sender_key_id: string | null;
    };
    expect(row.next_retry_at).toBe("2026-04-27 09:30:00");
    expect(row.sender_key_id).toBe("https://keys.local.example/u_outbound#rotated-v2");

    const fallbackRow = reopened.prepare("SELECT next_retry_at, sender_key_id FROM outbound_activity_deliveries WHERE id = ?").get("delivery-2") as {
      next_retry_at: string;
      sender_key_id: string | null;
    };
    expect(fallbackRow.next_retry_at).not.toBe("");
    expect(fallbackRow.sender_key_id).toBe("http://localhost:3000/users/u_outbound#main-key");
    expect(reopened.prepare("SELECT datetime(?) AS normalized").get(fallbackRow.next_retry_at)).toEqual({
      normalized: fallbackRow.next_retry_at,
    });
    reopened.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("skips outbound deliveries table rebuild when schema is already current", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "current-outbound-shape.sqlite");
    const versioned = new Database(dbPath);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 7)) {
      migration.up(versioned);
    }

    versioned.exec(`CREATE TABLE outbound_activity_deliveries (
      id TEXT PRIMARY KEY,
      destination_inbox TEXT NOT NULL,
      sender_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      sender_actor_uri TEXT NOT NULL,
      sender_key_id TEXT,
      activity_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','delivered','failed')),
      claimed_at TEXT,
      worker_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    versioned.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u-outbound-current", "u_outbound_current");
    versioned
      .prepare(
        `INSERT INTO outbound_activity_deliveries (
          id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json,
          next_retry_at, state, claimed_at, worker_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      )
      .run(
        "delivery-current",
        "https://remote.example/inbox",
        "u-outbound-current",
        "http://localhost:3000/users/u_outbound_current",
        "",
        '{"id":"https://example.test/activities/current","type":"Create"}',
        "2026-04-27T09:30:00.000Z",
        "processing",
        "worker-1"
      );
    versioned.pragma("user_version = 7");
    versioned.close();

    const reopened = initDatabase(dbPath);
    const row = reopened
      .prepare("SELECT state, worker_id, claimed_at, sender_key_id FROM outbound_activity_deliveries WHERE id = ?")
      .get("delivery-current") as {
      state: string;
      worker_id: string | null;
      claimed_at: string | null;
      sender_key_id: string | null;
    };

    expect(row.state).toBe("processing");
    expect(row.worker_id).toBe("worker-1");
    expect(row.claimed_at).not.toBeNull();
    expect(row.sender_key_id).toBe("http://localhost:3000/users/u_outbound_current#main-key");

    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes legacy event visibility and enforces it during migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy-events-visibility.sqlite");
    const versioned = new Database(dbPath);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
      migration.up(versioned);
    }

    versioned.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)").run("u-events-vis", "u_events_vis");
    versioned.prepare(
      `INSERT INTO events (
        id, account_id, title, start_date, start_at_utc, event_timezone, visibility
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "event-invalid-visibility",
      "u-events-vis",
      "Legacy visibility event",
      "2026-04-27",
      "2026-04-27T09:30:00.000Z",
      "UTC",
      "friends_only"
    );
    versioned.pragma("user_version = 8");
    versioned.close();

    const reopened = initDatabase(dbPath);
    const migrated = reopened.prepare("SELECT visibility FROM events WHERE id = ?").get("event-invalid-visibility") as {
      visibility: string;
    };
    expect(migrated.visibility).toBe("private");
    expect(() => {
      reopened.prepare("UPDATE events SET visibility = ? WHERE id = ?").run("friends_only", "event-invalid-visibility");
    }).toThrow(/invalid events\.visibility/);
    reopened.close();

    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates token hashes in bounded batches", () => {
    const dir = mkdtempSync(join(tmpdir(), "everycal-db-"));
    const dbPath = join(dir, "legacy-token-hashes.sqlite");
    const versioned = new Database(dbPath);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 5)) {
      migration.up(versioned);
    }

    const insertAccount = versioned.prepare("INSERT INTO accounts (id, username) VALUES (?, ?)");
    const insertVerification = versioned.prepare(
      "INSERT INTO email_verification_tokens (account_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 day'))"
    );
    const insertReset = versioned.prepare(
      "INSERT INTO password_reset_tokens (account_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 day'))"
    );
    const insertChange = versioned.prepare(
      "INSERT INTO email_change_requests (account_id, new_email, token, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))"
    );
    const insertFeed = versioned.prepare("INSERT INTO calendar_feed_tokens (account_id, token) VALUES (?, ?)");

    const tokenCount = 1200;
    for (let i = 0; i < tokenCount; i += 1) {
      const accountId = `u-batch-${i}`;
      insertAccount.run(accountId, `batch_user_${i}`);
      insertVerification.run(accountId, `plain-verification-${i}`);
      insertReset.run(accountId, `plain-reset-${i}`);
      insertChange.run(accountId, `batch_${i}@example.com`, `plain-change-${i}`);
      insertFeed.run(accountId, `plain-feed-${i}`);
    }

    const prehashedAccountId = "u-batch-prehashed";
    const prehashedVerification = hashTokenSecret("already-hashed-verification");
    const prehashedReset = hashTokenSecret("already-hashed-reset");
    const prehashedChange = hashTokenSecret("already-hashed-change");
    const prehashedFeed = hashTokenSecret("already-hashed-feed");
    insertAccount.run(prehashedAccountId, "batch_prehashed");
    insertVerification.run(prehashedAccountId, prehashedVerification);
    insertReset.run(prehashedAccountId, prehashedReset);
    insertChange.run(prehashedAccountId, "prehashed@example.com", prehashedChange);
    insertFeed.run(prehashedAccountId, prehashedFeed);

    versioned.pragma("user_version = 5");
    versioned.close();

    const reopened = initDatabase(dbPath);

    const plainVerificationCount = reopened
      .prepare("SELECT COUNT(*) AS count FROM email_verification_tokens WHERE token LIKE 'plain-%'")
      .get() as { count: number };
    const plainResetCount = reopened
      .prepare("SELECT COUNT(*) AS count FROM password_reset_tokens WHERE token LIKE 'plain-%'")
      .get() as { count: number };
    const plainChangeCount = reopened
      .prepare("SELECT COUNT(*) AS count FROM email_change_requests WHERE token LIKE 'plain-%'")
      .get() as { count: number };
    const plainFeedCount = reopened
      .prepare("SELECT COUNT(*) AS count FROM calendar_feed_tokens WHERE token LIKE 'plain-%'")
      .get() as { count: number };

    expect(plainVerificationCount.count).toBe(0);
    expect(plainResetCount.count).toBe(0);
    expect(plainChangeCount.count).toBe(0);
    expect(plainFeedCount.count).toBe(0);

    const verificationRow = reopened
      .prepare("SELECT token FROM email_verification_tokens WHERE account_id = ?")
      .get(prehashedAccountId) as { token: string };
    const resetRow = reopened
      .prepare("SELECT token FROM password_reset_tokens WHERE account_id = ?")
      .get(prehashedAccountId) as { token: string };
    const changeRow = reopened
      .prepare("SELECT token FROM email_change_requests WHERE account_id = ?")
      .get(prehashedAccountId) as { token: string };
    const feedRow = reopened
      .prepare("SELECT token FROM calendar_feed_tokens WHERE account_id = ?")
      .get(prehashedAccountId) as { token: string };

    expect(verificationRow.token).toBe(prehashedVerification);
    expect(resetRow.token).toBe(prehashedReset);
    expect(changeRow.token).toBe(prehashedChange);
    expect(feedRow.token).toBe(prehashedFeed);

    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }, 15000);

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
