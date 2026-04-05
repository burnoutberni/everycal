/**
 * SQLite database initialization and schema.
 */

import Database from "better-sqlite3";
import { uniqueRemoteEventSlug } from "./lib/slugs.js";
import { absoluteIsoWithOffsetToUtcIso, deriveUtcFromTemporalInput, isValidIanaTimezone } from "./lib/timezone.js";

export type DB = Database.Database;

const SYSTEM_TIMEZONE = "system";
const SYSTEM_DATE_TIME_LOCALE = "system";
const SYSTEM_THEME_PREFERENCE = "system";

const ISO_HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SQLITE_UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/;

function sqliteUtcDateTimeToUtcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!SQLITE_UTC_DATE_TIME.test(value)) return null;
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function canonicalUtcIso(value: string | null | undefined): string | null {
  if (!value) return null;
  if (ISO_HAS_OFFSET.test(value)) return absoluteIsoWithOffsetToUtcIso(value);
  return sqliteUtcDateTimeToUtcIso(value);
}

function extractDatePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return trimmed;
  const prefix = trimmed.slice(0, 10);
  return DATE_ONLY.test(prefix) ? prefix : null;
}

export function initDatabase(path: string): DB {
  const db = new Database(path);

  const tableHasColumn = (table: string, column: string): boolean => {
    try {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return columns.some((col) => col.name === column);
    } catch {
      return false;
    }
  };

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
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
      created_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      external_id TEXT,
      slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      start_at_utc TEXT NOT NULL,
      end_at_utc TEXT,
      event_timezone TEXT NOT NULL,
      start_on TEXT,
      end_on TEXT,
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
      canceled INTEGER NOT NULL DEFAULT 0,
      missing_since TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK(end_at_utc IS NULL OR end_at_utc >= start_at_utc)
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

    CREATE TABLE IF NOT EXISTS identity_memberships (
      identity_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      member_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','editor')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (identity_account_id, member_account_id)
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
    CREATE INDEX IF NOT EXISTS idx_events_visibility ON events(visibility);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events(account_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
    CREATE INDEX IF NOT EXISTS idx_identity_memberships_member ON identity_memberships(member_account_id);
    CREATE INDEX IF NOT EXISTS idx_identity_memberships_identity_role ON identity_memberships(identity_account_id, role);

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
      fetch_status TEXT NOT NULL DEFAULT 'active' CHECK(fetch_status IN ('active', 'error', 'gone')),
      last_error TEXT,
      next_retry_at TEXT,
      gone_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_remote_actors_domain ON remote_actors(domain);
    CREATE INDEX IF NOT EXISTS idx_remote_actors_username ON remote_actors(preferred_username, domain);

    -- Remote events (events fetched from remote actors)
    CREATE TABLE IF NOT EXISTS remote_events (
      uri TEXT PRIMARY KEY,
      actor_uri TEXT NOT NULL,
      slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      start_at_utc TEXT NOT NULL,
      end_at_utc TEXT,
      event_timezone TEXT,
      timezone_quality TEXT NOT NULL CHECK(timezone_quality IN ('exact_tzid','offset_only')),
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
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK((timezone_quality = 'exact_tzid' AND event_timezone IS NOT NULL) OR (timezone_quality != 'exact_tzid' AND event_timezone IS NULL)),
      CHECK(end_at_utc IS NULL OR end_at_utc >= start_at_utc)
    );

    CREATE INDEX IF NOT EXISTS idx_remote_events_actor ON remote_events(actor_uri);

    -- Track which remote actors local users follow
    CREATE TABLE IF NOT EXISTS remote_following (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      actor_uri TEXT NOT NULL,
      actor_inbox TEXT NOT NULL,
      follow_activity_id TEXT,
      follow_object_uri TEXT,
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

    -- Actor selection operations: audit bulk follow/repost changes
    CREATE TABLE IF NOT EXISTS actor_selection_operations (
      id TEXT PRIMARY KEY,
      action_kind TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      initiated_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('pending','completed','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS actor_selection_operation_items (
      operation_id TEXT NOT NULL REFERENCES actor_selection_operations(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      before_state INTEGER NOT NULL,
      after_state INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('added','removed','unchanged','error')),
      remote_status TEXT CHECK(remote_status IN ('none','pending','delivered','failed')),
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (operation_id, account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_actor_selection_ops_initiated_by ON actor_selection_operations(initiated_by_account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_actor_selection_items_operation ON actor_selection_operation_items(operation_id);

    -- Login attempt tracking for account lockout
    CREATE TABLE IF NOT EXISTS login_attempts (
      username TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_attempt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration guard: legacy schemas may miss temporal columns expected at runtime.
  try {
    if (!tableHasColumn("events", "start_at_utc")) db.exec("ALTER TABLE events ADD COLUMN start_at_utc TEXT");
    if (!tableHasColumn("events", "end_at_utc")) db.exec("ALTER TABLE events ADD COLUMN end_at_utc TEXT");
    if (!tableHasColumn("events", "event_timezone")) db.exec("ALTER TABLE events ADD COLUMN event_timezone TEXT");
    if (!tableHasColumn("events", "start_on")) db.exec("ALTER TABLE events ADD COLUMN start_on TEXT");
    if (!tableHasColumn("events", "end_on")) db.exec("ALTER TABLE events ADD COLUMN end_on TEXT");

    db.exec("UPDATE events SET event_timezone = 'UTC' WHERE event_timezone IS NULL OR trim(event_timezone) = ''");
    db.exec("UPDATE events SET start_on = substr(start_date, 1, 10) WHERE (start_on IS NULL OR trim(start_on) = '') AND start_date IS NOT NULL AND trim(start_date) != ''");
    db.exec("UPDATE events SET end_on = substr(end_date, 1, 10) WHERE (end_on IS NULL OR trim(end_on) = '') AND end_date IS NOT NULL AND trim(end_date) != ''");

    const temporalRows = db.prepare(`
      SELECT id, start_date, end_date, all_day, event_timezone, start_at_utc, end_at_utc, created_at
      FROM events
      WHERE start_at_utc IS NULL
         OR trim(start_at_utc) = ''
         OR (
           end_date IS NOT NULL
           AND trim(end_date) != ''
           AND (end_at_utc IS NULL OR trim(end_at_utc) = '')
         )
    `).all() as Array<{
      id: string;
      start_date: string;
      end_date: string | null;
      all_day: number;
      event_timezone: string;
      start_at_utc: string | null;
      end_at_utc: string | null;
      created_at: string | null;
    }>;

    const updateTemporal = db.prepare(`
      UPDATE events
      SET start_at_utc = ?, end_at_utc = ?, event_timezone = ?, start_on = ?, end_on = ?
      WHERE id = ?
    `);

    const nowIso = new Date().toISOString();
    for (const row of temporalRows) {
      const rawTimezone = row.event_timezone && row.event_timezone.trim() ? row.event_timezone.trim() : "UTC";
      const timezone = isValidIanaTimezone(rawTimezone) ? rawTimezone : "UTC";
      const allDay = !!row.all_day;
      const startDateRaw = row.start_date || "";
      const endDateRaw = row.end_date && row.end_date.trim() ? row.end_date : null;

      const nextStartAtUtc = canonicalUtcIso(row.start_at_utc)
        || deriveUtcFromTemporalInput(startDateRaw, { allDay, eventTimezone: timezone })
        || sqliteUtcDateTimeToUtcIso(row.created_at)
        || nowIso;

      let nextEndAtUtc = canonicalUtcIso(row.end_at_utc)
        || (endDateRaw
          ? deriveUtcFromTemporalInput(endDateRaw, { allDay, eventTimezone: timezone })
          : null);
      if (endDateRaw && !nextEndAtUtc) nextEndAtUtc = nextStartAtUtc;
      if (nextEndAtUtc && nextEndAtUtc < nextStartAtUtc) nextEndAtUtc = nextStartAtUtc;

      const startOn = extractDatePart(startDateRaw) || nextStartAtUtc.slice(0, 10);
      const endOn = extractDatePart(endDateRaw) || (endDateRaw ? nextEndAtUtc?.slice(0, 10) || nextStartAtUtc.slice(0, 10) : null);

      updateTemporal.run(nextStartAtUtc, nextEndAtUtc, timezone, startOn, endOn, row.id);
    }

    const unresolvedTemporalRows = db.prepare(`
      SELECT COUNT(*) AS total
      FROM events
      WHERE start_at_utc IS NULL
         OR trim(start_at_utc) = ''
         OR event_timezone IS NULL
         OR trim(event_timezone) = ''
         OR start_on IS NULL
         OR trim(start_on) = ''
         OR (
           end_date IS NOT NULL
           AND trim(end_date) != ''
           AND (
             end_at_utc IS NULL
             OR trim(end_at_utc) = ''
             OR end_on IS NULL
             OR trim(end_on) = ''
           )
         )
    `).get() as { total: number };

    if (unresolvedTemporalRows.total > 0) {
      throw new Error(`events temporal migration left ${unresolvedTemporalRows.total} invalid rows`);
    }

    if (tableHasColumn("events", "start_at_utc")) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at_utc)");
    }
  } catch (e) {
    if (tableHasColumn("events", "id")) throw e;
    // Ignore partial/legacy states where events table is not fully initialized.
  }

  try {
    if (!tableHasColumn("remote_events", "start_at_utc")) {
      const remoteFallbackExpr = tableHasColumn("remote_events", "fetched_at")
        ? "COALESCE(NULLIF(fetched_at, ''), datetime('now'))"
        : "datetime('now')";
      db.exec("BEGIN");
      try {
        db.exec("ALTER TABLE remote_events ADD COLUMN start_at_utc TEXT");
        db.exec(`
          UPDATE remote_events
          SET start_at_utc = COALESCE(NULLIF(start_date, ''), ${remoteFallbackExpr})
          WHERE start_at_utc IS NULL OR trim(start_at_utc) = ''
        `);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    if (tableHasColumn("remote_events", "start_at_utc")) {
      db.exec("CREATE INDEX IF NOT EXISTS idx_remote_events_start ON remote_events(start_at_utc)");
    }
  } catch {
    // Ignore partial/legacy states where remote_events table is not fully initialized
  }

  try {
    db.exec("ALTER TABLE remote_events ADD COLUMN end_at_utc TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_events ADD COLUMN event_timezone TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_events ADD COLUMN timezone_quality TEXT NOT NULL DEFAULT 'offset_only'");
  } catch {
    // Column already exists
  }
  try {
    db.exec("UPDATE remote_events SET timezone_quality = 'offset_only' WHERE timezone_quality IS NULL OR timezone_quality = '' OR timezone_quality NOT IN ('exact_tzid','offset_only')");
  } catch {
    // Ignore when table not yet initialized
  }

  // Migration: add follower_shared_inbox to remote_follows if missing
  try {
    db.exec("ALTER TABLE remote_follows ADD COLUMN follower_shared_inbox TEXT");
  } catch {
    // Column already exists
  }

  // Migration: store Follow activity references for interoperable Undo
  try {
    db.exec("ALTER TABLE remote_following ADD COLUMN follow_activity_id TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_following ADD COLUMN follow_object_uri TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("UPDATE remote_following SET follow_object_uri = follow_activity_id WHERE follow_object_uri IS NULL AND follow_activity_id IS NOT NULL");
  } catch {
    // Ignore when table not yet initialized
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

  // Migration: add default event visibility to accounts if missing
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN default_event_visibility TEXT NOT NULL DEFAULT 'public'");
  } catch {
    // Column already exists
  }

  // Migration: account type and delegated publishing membership tables
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN account_type TEXT NOT NULL DEFAULT 'person'");
  } catch {
    // Column already exists
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_memberships (
      identity_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      member_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','editor')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (identity_account_id, member_account_id)
    )
  `);
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_identity_memberships_member ON identity_memberships(member_account_id)");
  } catch {
    // Index already exists
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_identity_memberships_identity_role ON identity_memberships(identity_account_id, role)");
  } catch {
    // Index already exists
  }
  try {
    db.exec("UPDATE identity_memberships SET role = 'editor' WHERE role = 'admin'");
  } catch {
    // Ignore if table missing in partial init
  }

  // Migration: creator attribution for delegated publishing
  try {
    db.exec("ALTER TABLE events ADD COLUMN created_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL");
  } catch {
    // Column already exists
  }
  try {
    db.exec("UPDATE events SET created_by_account_id = account_id WHERE created_by_account_id IS NULL");
  } catch {
    // Ignore when events table not yet initialized
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
  try {
    db.exec("ALTER TABLE remote_actors ADD COLUMN fetch_status TEXT NOT NULL DEFAULT 'active' CHECK(fetch_status IN ('active', 'error', 'gone'))");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_actors ADD COLUMN last_error TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_actors ADD COLUMN next_retry_at TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE remote_actors ADD COLUMN gone_at TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("UPDATE remote_actors SET fetch_status = 'active' WHERE fetch_status IS NULL OR fetch_status = ''");
  } catch {
    // Ignore when table not yet initialized
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

  // Migration: local event cancellation state for scraper sync (never hard-delete missing events)
  try {
    db.exec("ALTER TABLE events ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE events ADD COLUMN missing_since TEXT");
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

  // Migration: store all-day semantic for remote events
  try {
    db.exec("ALTER TABLE remote_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }
  try {
    db.exec(`
      UPDATE remote_events
      SET all_day = 1
      WHERE start_date GLOB '????-??-??'
        AND (end_date IS NULL OR end_date GLOB '????-??-??')
    `);
  } catch {
    // Ignore when table not yet initialized
  }

  // Migration: canonicalize remote temporal fields into strict UTC + timezone contract
  try {
    const rows = db.prepare(`
      SELECT uri, start_date, end_date, all_day, start_at_utc, end_at_utc, event_timezone, timezone_quality, fetched_at
      FROM remote_events
    `).all() as Array<{
      uri: string;
      start_date: string;
      end_date: string | null;
      all_day: number;
      start_at_utc: string | null;
      end_at_utc: string | null;
      event_timezone: string | null;
      timezone_quality: string | null;
      fetched_at: string | null;
    }>;

    const updateTemporal = db.prepare(`
      UPDATE remote_events
      SET all_day = ?, start_at_utc = ?, end_at_utc = ?, event_timezone = ?, timezone_quality = ?
      WHERE uri = ?
    `);

    const nowIso = new Date().toISOString();
    for (const row of rows) {
      const inferredAllDay = DATE_ONLY.test(row.start_date) && (!row.end_date || DATE_ONLY.test(row.end_date));
      const allDay = !!row.all_day || inferredAllDay;

      const rawTimezone = row.event_timezone && row.event_timezone.trim() ? row.event_timezone.trim() : null;
      const wantsExactTimezone = row.timezone_quality === "exact_tzid";
      const timezone = rawTimezone && wantsExactTimezone && isValidIanaTimezone(rawTimezone) ? rawTimezone : null;

      const nextStartAtUtc = deriveUtcFromTemporalInput(
        row.start_date,
        { allDay, eventTimezone: timezone },
      )
        || canonicalUtcIso(row.start_at_utc)
        || canonicalUtcIso(row.fetched_at)
        || nowIso;

      let nextEndAtUtc = deriveUtcFromTemporalInput(
        row.end_date,
        { allDay, eventTimezone: timezone },
      )
        || canonicalUtcIso(row.end_at_utc);
      if (row.end_date && !nextEndAtUtc) nextEndAtUtc = nextStartAtUtc;
      if (nextEndAtUtc && nextEndAtUtc < nextStartAtUtc) nextEndAtUtc = nextStartAtUtc;

      const nextTimezoneQuality = timezone ? "exact_tzid" : "offset_only";
      updateTemporal.run(allDay ? 1 : 0, nextStartAtUtc, nextEndAtUtc, timezone, nextTimezoneQuality, row.uri);
    }
  } catch {
    // Ignore when table not yet initialized
  }

  // Migration: immutable slug for remote event canonical URLs
  try {
    db.exec("ALTER TABLE remote_events ADD COLUMN slug TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL");
  } catch {
    // Index already exists
  }

  // Migration: backfill missing remote slugs for already-cached events
  try {
    const missing = db
      .prepare(
        `SELECT uri, actor_uri, title
         FROM remote_events
         WHERE slug IS NULL OR slug = ''
         ORDER BY fetched_at ASC, uri ASC`
      )
      .all() as Array<{ uri: string; actor_uri: string; title: string }>;
    const updateSlug = db.prepare("UPDATE remote_events SET slug = ? WHERE uri = ?");
    for (const row of missing) {
      const slug = uniqueRemoteEventSlug(db, row.actor_uri, row.title || "event");
      updateSlug.run(slug, row.uri);
    }
  } catch {
    // Ignore partial/legacy states where remote_events may not be initialized yet
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

  // Migration: preferred language for i18n
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN preferred_language TEXT DEFAULT 'en'");
  } catch {
    // Column already exists
  }

  // Migration: og_image_url for custom OG images
  try {
    db.exec("ALTER TABLE events ADD COLUMN og_image_url TEXT");
  } catch {
    // Column already exists
  }


  try {
    db.exec("ALTER TABLE accounts ADD COLUMN timezone TEXT NOT NULL DEFAULT 'system'");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN date_time_locale TEXT NOT NULL DEFAULT 'system'");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN theme_preference TEXT NOT NULL DEFAULT 'system' CHECK(theme_preference IN ('system','light','dark'))");
  } catch {
    // Column already exists
  }

  // Migration: normalize accounts column defaults for timezone/locale on legacy DBs
  try {
    const accountCols = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string; dflt_value: string | null }>;
    const timezoneDefault = accountCols.find((col) => col.name === "timezone")?.dflt_value;
    const localeDefault = accountCols.find((col) => col.name === "date_time_locale")?.dflt_value;
    const needsAccountsDefaultRebuild = timezoneDefault !== "'system'" || localeDefault !== "'system'";

    if (needsAccountsDefaultRebuild) {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN");
      try {
        db.exec(`
          CREATE TABLE accounts_new (
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
            city TEXT NOT NULL DEFAULT 'Wien',
            city_lat REAL NOT NULL DEFAULT 48.2082,
            city_lng REAL NOT NULL DEFAULT 16.3738,
            email TEXT,
            email_verified INTEGER NOT NULL DEFAULT 0,
            email_verified_at TEXT,
            preferred_language TEXT DEFAULT 'en'
          )
        `);
        db.exec(`
          INSERT INTO accounts_new (
            id, username, account_type, display_name, bio, avatar_url, password_hash, private_key, public_key,
            is_bot, discoverable, timezone, date_time_locale, theme_preference, default_event_visibility, created_at, updated_at,
            website, city, city_lat, city_lng, email, email_verified, email_verified_at, preferred_language
          )
          SELECT
            id,
            username,
            account_type,
            display_name,
            bio,
            avatar_url,
            password_hash,
            private_key,
            public_key,
            is_bot,
            discoverable,
            COALESCE(NULLIF(timezone, ''), '${SYSTEM_TIMEZONE}') AS timezone,
            COALESCE(NULLIF(date_time_locale, ''), '${SYSTEM_DATE_TIME_LOCALE}') AS date_time_locale,
            CASE lower(trim(COALESCE(theme_preference, '')))
              WHEN 'system' THEN 'system'
              WHEN 'light' THEN 'light'
              WHEN 'dark' THEN 'dark'
              ELSE '${SYSTEM_THEME_PREFERENCE}'
            END AS theme_preference,
            default_event_visibility,
            created_at,
            updated_at,
            website,
            city,
            city_lat,
            city_lng,
            email,
            email_verified,
            email_verified_at,
            preferred_language
          FROM accounts
        `);
        db.exec("DROP TABLE accounts");
        db.exec("ALTER TABLE accounts_new RENAME TO accounts");
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    }
  } catch {
    // Ignore during partial initialization
  }

  try {
    db.exec(
      `UPDATE accounts
       SET timezone = '${SYSTEM_TIMEZONE}'
       WHERE timezone IS NULL OR trim(timezone) = ''`
    );
    db.exec(
      `UPDATE accounts
       SET date_time_locale = '${SYSTEM_DATE_TIME_LOCALE}'
       WHERE date_time_locale IS NULL
          OR trim(date_time_locale) = ''`
    );
    db.exec(
      `UPDATE accounts
       SET theme_preference = '${SYSTEM_THEME_PREFERENCE}'
       WHERE theme_preference IS NULL
          OR trim(theme_preference) = ''
          OR theme_preference NOT IN ('system', 'light', 'dark')`
    );
  } catch {
    // Ignore during partial initialization
  }
  db.exec("DROP TRIGGER IF EXISTS trg_accounts_time_format_insert");
  db.exec("DROP TRIGGER IF EXISTS trg_accounts_time_format_update");
  try {
    db.exec("ALTER TABLE accounts DROP COLUMN time_format");
  } catch {
    // Column does not exist or SQLite version does not support DROP COLUMN
  }


  return db;
}
