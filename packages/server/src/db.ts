/**
 * SQLite database initialization and schema.
 */

import Database from "better-sqlite3";

export type DB = Database.Database;

export function initDatabase(path: string): DB {
  const db = new Database(path);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      bio TEXT,
      avatar_url TEXT,
      password_hash TEXT,
      private_key TEXT,
      public_key TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      discoverable INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      external_id TEXT,
      slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      location_name TEXT,
      location_address TEXT,
      location_latitude REAL,
      location_longitude REAL,
      location_url TEXT,
      image_url TEXT,
      image_media_type TEXT,
      image_alt TEXT,
      url TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS event_tags (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (event_id, tag)
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      following_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, following_id)
    );

    CREATE TABLE IF NOT EXISTS remote_follows (
      account_id TEXT NOT NULL REFERENCES accounts(id),
      follower_actor_uri TEXT NOT NULL,
      follower_inbox TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, follower_actor_uri)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);

    CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id);
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_date);
    CREATE INDEX IF NOT EXISTS idx_events_visibility ON events(visibility);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events(account_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

    -- Remote actors (cached ActivityPub actors from other servers)
    CREATE TABLE IF NOT EXISTS remote_actors (
      uri TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'Person',
      preferred_username TEXT NOT NULL,
      display_name TEXT,
      summary TEXT,
      inbox TEXT NOT NULL,
      outbox TEXT,
      shared_inbox TEXT,
      followers_url TEXT,
      following_url TEXT,
      icon_url TEXT,
      image_url TEXT,
      public_key_id TEXT,
      public_key_pem TEXT,
      domain TEXT NOT NULL,
      last_fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_remote_actors_domain ON remote_actors(domain);
    CREATE INDEX IF NOT EXISTS idx_remote_actors_username ON remote_actors(preferred_username, domain);

    -- Remote events (events fetched from remote actors)
    CREATE TABLE IF NOT EXISTS remote_events (
      uri TEXT PRIMARY KEY,
      actor_uri TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      location_name TEXT,
      location_address TEXT,
      location_latitude REAL,
      location_longitude REAL,
      image_url TEXT,
      image_media_type TEXT,
      image_alt TEXT,
      url TEXT,
      tags TEXT,
      raw_json TEXT,
      published TEXT,
      updated TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_remote_events_actor ON remote_events(actor_uri);
    CREATE INDEX IF NOT EXISTS idx_remote_events_start ON remote_events(start_date);

    -- Track which remote actors local users follow
    CREATE TABLE IF NOT EXISTS remote_following (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      actor_uri TEXT NOT NULL,
      actor_inbox TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, actor_uri)
    );

    CREATE INDEX IF NOT EXISTS idx_remote_following_account ON remote_following(account_id);

    -- Domain discovery: track when we last fetched full profile list from a remote server
    CREATE TABLE IF NOT EXISTS domain_discovery (
      domain TEXT PRIMARY KEY,
      last_discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      software_type TEXT
    );

    -- RSVPs: track attendance status for any event (local or remote)
    -- event_uri is the local event ID for local events, or the remote event URI for remote events
    CREATE TABLE IF NOT EXISTS event_rsvps (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      event_uri TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('going','maybe')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, event_uri)
    );

    CREATE INDEX IF NOT EXISTS idx_event_rsvps_account ON event_rsvps(account_id);
    CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_uri);

    -- Reposts: a user reposts a single event onto their feed
    CREATE TABLE IF NOT EXISTS reposts (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reposts_account ON reposts(account_id);
    CREATE INDEX IF NOT EXISTS idx_reposts_event ON reposts(event_id);

    -- Auto-reposts: automatically repost all public events from source account
    CREATE TABLE IF NOT EXISTS auto_reposts (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      source_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, source_account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_auto_reposts_account ON auto_reposts(account_id);
    CREATE INDEX IF NOT EXISTS idx_auto_reposts_source ON auto_reposts(source_account_id);

    -- Login attempt tracking for account lockout
    CREATE TABLE IF NOT EXISTS login_attempts (
      username TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_attempt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: add follower_shared_inbox to remote_follows if missing
  try {
    db.exec("ALTER TABLE remote_follows ADD COLUMN follower_shared_inbox TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add is_bot and discoverable to accounts if missing
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  // Migration: add website to accounts if missing
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN website TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add followers_count, following_count to remote_actors
  try {
    db.exec("ALTER TABLE remote_actors ADD COLUMN followers_count INTEGER");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_actors ADD COLUMN following_count INTEGER");
  } catch {
    // Column already exists
  }

  // Migration: add slug to events if missing
  try {
    db.exec("ALTER TABLE events ADD COLUMN slug TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL");
  } catch {
    // Index already exists
  }

  // Migration: add content_hash to events for change detection during sync
  try {
    db.exec("ALTER TABLE events ADD COLUMN content_hash TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add key_prefix to api_keys for fast lookup
  try {
    db.exec("ALTER TABLE api_keys ADD COLUMN key_prefix TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)");
  } catch {
    // Index already exists
  }

  // Migration: calendar_feed_tokens table (may have been created with token_hash in an earlier version)
  const cftTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='calendar_feed_tokens'"
  ).get() as { sql: string } | undefined;
  const cftHasToken = cftTable?.sql?.includes(" token ");
  const needsRecreate = !cftTable || !cftHasToken;
  if (needsRecreate) {
    if (cftTable) db.exec("DROP TABLE calendar_feed_tokens");
    db.exec(`
      CREATE TABLE calendar_feed_tokens (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_calendar_feed_tokens_token ON calendar_feed_tokens(token);
    `);
  } else {
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_calendar_feed_tokens_token ON calendar_feed_tokens(token)");
    } catch {
      // Index already exists
    }
  }

  // Migration: remove "interested" from event_rsvps (recreate table with new CHECK constraint)
  const rsvpTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='event_rsvps'"
  ).get() as { sql: string } | undefined;
  const rsvpNewTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_rsvps_new'"
  ).get();

  if (rsvpNewTable) {
    // Recovery: previous migration failed partway; event_rsvps_new exists, event_rsvps was dropped
    db.exec("BEGIN");
    try {
      db.exec(`
        ALTER TABLE event_rsvps_new RENAME TO event_rsvps;
        CREATE INDEX IF NOT EXISTS idx_event_rsvps_account ON event_rsvps(account_id);
        CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_uri);
      `);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } else if (rsvpTable?.sql?.includes("'interested'")) {
    db.exec("BEGIN");
    try {
      db.exec(`
        DELETE FROM event_rsvps WHERE status = 'interested';
        CREATE TABLE event_rsvps_new (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          event_uri TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('going','maybe')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (account_id, event_uri)
        );
        INSERT INTO event_rsvps_new SELECT * FROM event_rsvps;
        DROP TABLE event_rsvps;
        ALTER TABLE event_rsvps_new RENAME TO event_rsvps;
        CREATE INDEX IF NOT EXISTS idx_event_rsvps_account ON event_rsvps(account_id);
        CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_uri);
      `);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // Migration: add city fields to accounts (default Wien for existing users)
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN city TEXT NOT NULL DEFAULT 'Wien'");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN city_lat REAL NOT NULL DEFAULT 48.2082");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN city_lng REAL NOT NULL DEFAULT 16.3738");
  } catch {
    // Column already exists
  }

  // Migration: add image_attribution for Unsplash/Openverse crediting
  try {
    db.exec("ALTER TABLE events ADD COLUMN image_attribution TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_events ADD COLUMN image_attribution TEXT");
  } catch {
    // Column already exists
  }

  // Migration: canceled flag for remote events (ActivityPub Delete = mark canceled, not delete)
  try {
    db.exec("ALTER TABLE remote_events ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      address TEXT,
      latitude REAL,
      longitude REAL,
      used_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, name, address)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_saved_locations_account ON saved_locations(account_id, used_at DESC)");

  // Migration: email and verification for accounts
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN email TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN email_verified_at TEXT");
  } catch {
    // Column already exists
  }

  // Grandfather existing accounts (no email) as verified so they can still log in
  try {
    db.exec("UPDATE accounts SET email_verified = 1 WHERE email IS NULL");
  } catch {
    // Ignore
  }

  // Migration: email verification tokens
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (account_id)
    )
  `);
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_token ON email_verification_tokens(token)");
  } catch {
    // Index already exists
  }

  // Migration: password reset tokens
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (account_id)
    )
  `);
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token ON password_reset_tokens(token)");
  } catch {
    // Index already exists
  }

  // Migration: account notification preferences
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_notification_prefs (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      reminder_enabled INTEGER NOT NULL DEFAULT 1,
      reminder_hours_before INTEGER NOT NULL DEFAULT 24,
      event_updated_enabled INTEGER NOT NULL DEFAULT 1,
      event_cancelled_enabled INTEGER NOT NULL DEFAULT 1,
      onboarding_completed INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Migration: email change requests (add/change email with verification)
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_change_requests (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      new_email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (account_id)
    )
  `);
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_email_change_requests_token ON email_change_requests(token)");
  } catch {
    /* index exists */
  }

  // Migration: event reminder sent (prevent duplicate reminders)
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_reminder_sent (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      event_uri TEXT NOT NULL,
      reminder_type TEXT NOT NULL DEFAULT '24h',
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, event_uri, reminder_type)
    )
  `);
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_event_reminder_sent_account ON event_reminder_sent(account_id)");
  } catch {
    // Index already exists
  }

  return db;
}
