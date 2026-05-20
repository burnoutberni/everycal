import type { DB } from "../db.js";
import { getBaseUrl } from "../lib/base-url.js";
import { hashTokenSecret } from "../lib/token-secrets.js";

export type Migration = {
  version: number;
  name: string;
  up: (db: DB) => void;
};

const BASELINE_SCHEMA_SQL = `
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  key_prefix TEXT
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
  image_attribution TEXT,
  og_image_url TEXT,
  url TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  content_hash TEXT,
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
  follower_shared_inbox TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, follower_actor_uri)
);

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
  followers_count INTEGER,
  following_count INTEGER,
  last_fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  fetch_status TEXT NOT NULL DEFAULT 'active' CHECK(fetch_status IN ('active', 'error', 'gone')),
  last_error TEXT,
  next_retry_at TEXT,
  gone_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  start_on TEXT,
  end_on TEXT,
  event_timezone TEXT,
  timezone_quality TEXT NOT NULL CHECK(timezone_quality IN ('exact_tzid','offset_only')),
  location_name TEXT,
  location_address TEXT,
  location_latitude REAL,
  location_longitude REAL,
  image_url TEXT,
  image_media_type TEXT,
  image_alt TEXT,
  image_attribution TEXT,
  url TEXT,
  tags TEXT,
  raw_json TEXT,
  published TEXT,
  updated TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  canceled INTEGER NOT NULL DEFAULT 0,
  CHECK((timezone_quality = 'exact_tzid' AND event_timezone IS NOT NULL) OR (timezone_quality != 'exact_tzid' AND event_timezone IS NULL)),
  CHECK(end_at_utc IS NULL OR end_at_utc >= start_at_utc)
);

CREATE TABLE IF NOT EXISTS remote_following (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor_uri TEXT NOT NULL,
  actor_inbox TEXT NOT NULL,
  follow_activity_id TEXT,
  follow_object_uri TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, actor_uri)
);

CREATE TABLE IF NOT EXISTS domain_discovery (
  domain TEXT PRIMARY KEY,
  last_discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  software_type TEXT
);

CREATE TABLE IF NOT EXISTS event_rsvps (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_uri TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('going','maybe')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, event_uri)
);

CREATE TABLE IF NOT EXISTS remote_event_rsvps (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_uri TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('going','maybe','not_going')),
  last_activity_id TEXT,
  last_activity_type TEXT NOT NULL,
  last_activity_published_at TEXT,
  last_activity_precedence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, actor_uri)
);

CREATE TABLE IF NOT EXISTS reposts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  event_uri TEXT NOT NULL,
  source_actor_uri TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, event_uri)
);

CREATE TABLE IF NOT EXISTS auto_reposts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  source_actor_uri TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, source_actor_uri)
);

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

CREATE TABLE IF NOT EXISTS login_attempts (
  username TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_attempt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  latitude REAL,
  longitude REAL,
  used_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, name, address)
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id)
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id)
);

CREATE TABLE IF NOT EXISTS account_notification_prefs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  reminder_hours_before INTEGER NOT NULL DEFAULT 24,
  event_updated_enabled INTEGER NOT NULL DEFAULT 1,
  event_cancelled_enabled INTEGER NOT NULL DEFAULT 1,
  onboarding_completed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS email_change_requests (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  new_email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id)
);

CREATE TABLE IF NOT EXISTS event_reminder_sent (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_uri TEXT NOT NULL,
  reminder_type TEXT NOT NULL DEFAULT '24h',
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, event_uri, reminder_type)
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id);
CREATE INDEX IF NOT EXISTS idx_events_visibility ON events(visibility);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_external ON events(account_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug ON events(account_id, slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_start_at_utc ON events(start_at_utc);
CREATE INDEX IF NOT EXISTS idx_events_start_on ON events(start_on);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_identity_memberships_member ON identity_memberships(member_account_id);
CREATE INDEX IF NOT EXISTS idx_identity_memberships_identity_role ON identity_memberships(identity_account_id, role);
CREATE INDEX IF NOT EXISTS idx_remote_actors_domain ON remote_actors(domain);
CREATE INDEX IF NOT EXISTS idx_remote_actors_username ON remote_actors(preferred_username, domain);
CREATE INDEX IF NOT EXISTS idx_remote_events_actor ON remote_events(actor_uri);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_events_actor_slug ON remote_events(actor_uri, slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_remote_events_start_at_utc ON remote_events(start_at_utc);
CREATE INDEX IF NOT EXISTS idx_remote_events_start_on ON remote_events(start_on);
CREATE INDEX IF NOT EXISTS idx_remote_following_account ON remote_following(account_id);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_account ON event_rsvps(account_id);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_uri);
CREATE INDEX IF NOT EXISTS idx_remote_event_rsvps_event_status ON remote_event_rsvps(event_id, status);
CREATE INDEX IF NOT EXISTS idx_remote_event_rsvps_actor ON remote_event_rsvps(actor_uri);
CREATE INDEX IF NOT EXISTS idx_reposts_account ON reposts(account_id);
CREATE INDEX IF NOT EXISTS idx_reposts_event ON reposts(event_id);
CREATE INDEX IF NOT EXISTS idx_reposts_event_uri ON reposts(event_uri);
CREATE INDEX IF NOT EXISTS idx_auto_reposts_account ON auto_reposts(account_id);
CREATE INDEX IF NOT EXISTS idx_auto_reposts_source ON auto_reposts(source_account_id);
CREATE INDEX IF NOT EXISTS idx_auto_reposts_source_actor ON auto_reposts(source_actor_uri);
CREATE INDEX IF NOT EXISTS idx_actor_selection_ops_initiated_by ON actor_selection_operations(initiated_by_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_actor_selection_items_operation ON actor_selection_operation_items(operation_id);
CREATE INDEX IF NOT EXISTS idx_saved_locations_account ON saved_locations(account_id, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_reminder_sent_account ON event_reminder_sent(account_id);
CREATE INDEX IF NOT EXISTS idx_event_tags_tag_event_id ON event_tags(tag, event_id);
CREATE INDEX IF NOT EXISTS idx_remote_following_actor_account ON remote_following(actor_uri, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_locations_unique_addr
  ON saved_locations(account_id, name, ifnull(address, ''));
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline_schema",
    up: (db) => {
      db.exec(BASELINE_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: "remote_events_og_image_url",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(remote_events)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "og_image_url")) {
        db.exec("ALTER TABLE remote_events ADD COLUMN og_image_url TEXT");
      }
    },
  },
  {
    version: 3,
    name: "bot_accounts_passwordless_only",
    up: (db) => {
      db.exec("UPDATE accounts SET password_hash = NULL WHERE is_bot = 1");
      db.exec(
        "DELETE FROM password_reset_tokens WHERE account_id IN (SELECT id FROM accounts WHERE is_bot = 1)"
      );
    },
  },
  {
    version: 4,
    name: "normalize_token_expiry_format",
    up: (db) => {
      db.exec(
        "UPDATE email_verification_tokens SET expires_at = datetime(expires_at) WHERE datetime(expires_at) IS NOT NULL"
      );
      db.exec(
        "UPDATE password_reset_tokens SET expires_at = datetime(expires_at) WHERE datetime(expires_at) IS NOT NULL"
      );
      db.exec(
        "UPDATE email_change_requests SET expires_at = datetime(expires_at) WHERE datetime(expires_at) IS NOT NULL"
      );
    },
  },
  {
    version: 5,
    name: "normalize_session_expiry_format",
    up: (db) => {
      db.exec("UPDATE sessions SET expires_at = datetime(expires_at) WHERE datetime(expires_at) IS NOT NULL");
    },
  },
  {
    version: 6,
    name: "harden_tokens_and_indexes",
    up: (db) => {
      const tokenTables = [
        "email_verification_tokens",
        "password_reset_tokens",
        "email_change_requests",
        "calendar_feed_tokens",
      ] as const;
      const batchSize = 500;
      for (const table of tokenTables) {
        const selectBatch = db.prepare(
          `SELECT rowid AS rowid, token FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`
        );
        const update = db.prepare(`UPDATE ${table} SET token = ? WHERE rowid = ?`);
        let lastRowId = 0;
        while (true) {
          const rows = selectBatch.all(lastRowId, batchSize) as Array<{ rowid: number; token: string }>;
          if (rows.length === 0) break;

          for (const row of rows) {
            if (/^[a-f0-9]{64}$/i.test(row.token)) continue;
            update.run(hashTokenSecret(row.token), row.rowid);
          }

          lastRowId = rows[rows.length - 1].rowid;
        }
      }

      db.exec("CREATE INDEX IF NOT EXISTS idx_event_tags_tag_event_id ON event_tags(tag, event_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_remote_following_actor_account ON remote_following(actor_uri, account_id)");

      db.exec(
        `DELETE FROM saved_locations
         WHERE id NOT IN (
           SELECT MAX(id) FROM saved_locations
           GROUP BY account_id, name, ifnull(address, '')
         )`
      );
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_locations_unique_addr ON saved_locations(account_id, name, ifnull(address, ''))"
      );
    },
  },
  {
    version: 7,
    name: "calendar_feed_token_versions",
    up: (db) => {
      const columns = db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "calendar_feed_token_version")) {
        db.exec("ALTER TABLE accounts ADD COLUMN calendar_feed_token_version INTEGER NOT NULL DEFAULT 1");
      }
      db.exec(
        "UPDATE accounts SET calendar_feed_token_version = 1 WHERE calendar_feed_token_version IS NULL OR calendar_feed_token_version < 1"
      );
    },
  },
  {
    version: 8,
    name: "federation_hardening",
    up: (db) => {
      const remoteEventColumns = db.prepare("PRAGMA table_info(remote_events)").all() as Array<{ name: string }>;
      const outboundDeliveryColumns = db.prepare("PRAGMA table_info(outbound_activity_deliveries)").all() as Array<{ name: string }>;
      const shouldRebuildOutboundDeliveries =
        outboundDeliveryColumns.length > 0 &&
        ["claimed_at", "worker_id", "sender_key_id", "state", "next_retry_at"].some(
          (columnName) => !outboundDeliveryColumns.some((column) => column.name === columnName)
        );
      if (!remoteEventColumns.some((column) => column.name === "visibility")) {
        db.exec("ALTER TABLE remote_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','unlisted','followers_only','private'))");
      }
      db.exec("UPDATE remote_events SET visibility = 'public' WHERE visibility IS NULL OR visibility NOT IN ('public','unlisted','followers_only','private')");
      db.exec(`CREATE TABLE IF NOT EXISTS outbound_activity_deliveries (
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
      db.exec(`CREATE TABLE IF NOT EXISTS processed_inbox_activities (
        activity_id TEXT NOT NULL,
        actor_uri TEXT NOT NULL,
        target_context TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processed' CHECK(status IN ('processing','processed','failed')),
        claimed_at TEXT,
        processed_at TEXT,
        last_error TEXT,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (activity_id, actor_uri, target_context)
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_remote_events_visibility ON remote_events(visibility)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_state_retry ON outbound_activity_deliveries(state, next_retry_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_sender ON outbound_activity_deliveries(sender_account_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_processing_claimed ON outbound_activity_deliveries(state, claimed_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_processed_inbox_received ON processed_inbox_activities(received_at)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_processed_inbox_status_claimed ON processed_inbox_activities(status, claimed_at)");
      db.exec(
        "UPDATE outbound_activity_deliveries SET next_retry_at = COALESCE(datetime(next_retry_at), datetime('now'))"
      );

      if (shouldRebuildOutboundDeliveries) {
        db.exec(`CREATE TABLE outbound_activity_deliveries_tmp (
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
        db.exec(`INSERT INTO outbound_activity_deliveries_tmp (
          id, destination_inbox, sender_account_id, sender_actor_uri, sender_key_id, activity_json,
          attempt_count, next_retry_at, last_error, state, claimed_at, worker_id, created_at, updated_at
        )
        SELECT
          id, destination_inbox, sender_account_id, sender_actor_uri,
          COALESCE(NULLIF(sender_key_id, ''), sender_actor_uri || '#main-key'),
          activity_json,
          attempt_count, COALESCE(datetime(next_retry_at), datetime('now')), last_error,
          CASE WHEN state IN ('pending', 'delivered', 'failed') THEN state ELSE 'pending' END,
          NULL, NULL, created_at, updated_at
        FROM outbound_activity_deliveries`);
        db.exec("DROP TABLE outbound_activity_deliveries");
        db.exec("ALTER TABLE outbound_activity_deliveries_tmp RENAME TO outbound_activity_deliveries");
        db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_state_retry ON outbound_activity_deliveries(state, next_retry_at)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_sender ON outbound_activity_deliveries(sender_account_id)");
        db.exec("CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_processing_claimed ON outbound_activity_deliveries(state, claimed_at)");
      }
      db.exec(
        "UPDATE outbound_activity_deliveries SET sender_key_id = sender_actor_uri || '#main-key' WHERE sender_key_id IS NULL OR sender_key_id = ''"
      );
    },
  },
  {
    version: 9,
    name: "events_visibility_guardrails",
    up: (db) => {
      db.exec("UPDATE events SET visibility = 'private' WHERE visibility IS NULL OR visibility NOT IN ('public','unlisted','followers_only','private')");
      db.exec("DROP TRIGGER IF EXISTS validate_events_visibility_insert");
      db.exec("DROP TRIGGER IF EXISTS validate_events_visibility_update");
      db.exec(`CREATE TRIGGER validate_events_visibility_insert
        BEFORE INSERT ON events
        FOR EACH ROW
        WHEN NEW.visibility NOT IN ('public','unlisted','followers_only','private')
        BEGIN
          SELECT RAISE(ABORT, 'invalid events.visibility');
        END`);
      db.exec(`CREATE TRIGGER validate_events_visibility_update
        BEFORE UPDATE OF visibility ON events
        FOR EACH ROW
        WHEN NEW.visibility NOT IN ('public','unlisted','followers_only','private')
        BEGIN
          SELECT RAISE(ABORT, 'invalid events.visibility');
        END`);
    },
  },
  {
    version: 10,
    name: "universal_reposts_canonicalization",
    up: (db) => {
      const isTestEnv = process.env.NODE_ENV === "test";
      const configuredBaseUrl = process.env.BASE_URL;
      if (!isTestEnv && (!configuredBaseUrl || configuredBaseUrl.trim().length === 0)) {
        throw new Error("BASE_URL must be configured before running migration v10 (universal_reposts_canonicalization)");
      }
      const baseUrl = getBaseUrl();

      db.exec(`CREATE TABLE IF NOT EXISTS remote_event_rsvps (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        actor_uri TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('going','maybe','not_going')),
        last_activity_id TEXT,
        last_activity_type TEXT NOT NULL,
        last_activity_published_at TEXT,
        last_activity_precedence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (event_id, actor_uri)
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_remote_event_rsvps_event_status ON remote_event_rsvps(event_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_remote_event_rsvps_actor ON remote_event_rsvps(actor_uri)");

      const repostColumns = db.prepare("PRAGMA table_info(reposts)").all() as Array<{ name: string }>;
      const autoRepostColumns = db.prepare("PRAGMA table_info(auto_reposts)").all() as Array<{ name: string }>;
      const hasRepostEventUri = repostColumns.some((column) => column.name === "event_uri");
      const hasRepostSourceActorUri = repostColumns.some((column) => column.name === "source_actor_uri");
      const hasAutoRepostSourceActorUri = autoRepostColumns.some((column) => column.name === "source_actor_uri");

      const repostEventUriExpr = hasRepostEventUri ? "r.event_uri" : "r.event_id";
      const repostSourceActorUriExpr = hasRepostSourceActorUri ? "r.source_actor_uri" : "NULL";
      const autoRepostSourceActorUriExpr = hasAutoRepostSourceActorUri ? "ar.source_actor_uri" : "NULL";

      db.exec(`CREATE TABLE IF NOT EXISTS reposts_tmp (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        event_uri TEXT NOT NULL,
        source_actor_uri TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, event_uri)
      )`);
      db.exec(`INSERT OR IGNORE INTO reposts_tmp (account_id, event_id, event_uri, source_actor_uri, created_at)
        SELECT r.account_id,
               r.event_id,
               CASE
                 WHEN r.event_id IS NOT NULL THEN '${baseUrl}/events/' || r.event_id
                 ELSE COALESCE(${repostEventUriExpr}, '')
               END AS event_uri,
                CASE
                  WHEN e_owner.username IS NOT NULL THEN '${baseUrl}/users/' || e_owner.username
                  ELSE ${repostSourceActorUriExpr}
                END AS source_actor_uri,
               r.created_at
        FROM reposts r
        LEFT JOIN events e ON e.id = r.event_id
        LEFT JOIN accounts e_owner ON e_owner.id = e.account_id
        ORDER BY datetime(r.created_at) ASC, r.rowid ASC`);
      db.exec("DROP TABLE reposts");
      db.exec("ALTER TABLE reposts_tmp RENAME TO reposts");
      db.exec("CREATE INDEX IF NOT EXISTS idx_reposts_account ON reposts(account_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_reposts_event ON reposts(event_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_reposts_event_uri ON reposts(event_uri)");

      db.exec(`CREATE TABLE IF NOT EXISTS auto_reposts_tmp (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        source_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
        source_actor_uri TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_id, source_actor_uri)
      )`);
      db.exec(`INSERT OR IGNORE INTO auto_reposts_tmp (account_id, source_account_id, source_actor_uri, created_at)
        SELECT ar.account_id,
               CASE WHEN a.id IS NOT NULL THEN ar.source_account_id ELSE NULL END AS source_account_id,
               COALESCE(
                  ${autoRepostSourceActorUriExpr},
                  CASE
                    WHEN a.username IS NOT NULL THEN '${baseUrl}/users/' || a.username
                    ELSE ('https://local.invalid/users/deleted-' || COALESCE(ar.source_account_id, 'row-' || ar.rowid))
                  END
                ) AS source_actor_uri,
                ar.created_at
        FROM auto_reposts ar
        LEFT JOIN accounts a ON a.id = ar.source_account_id`);
      db.exec("DROP TABLE auto_reposts");
      db.exec("ALTER TABLE auto_reposts_tmp RENAME TO auto_reposts");
      db.exec("CREATE INDEX IF NOT EXISTS idx_auto_reposts_account ON auto_reposts(account_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_auto_reposts_source ON auto_reposts(source_account_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_auto_reposts_source_actor ON auto_reposts(source_actor_uri)");
    },
  },
];

export const CURRENT_SCHEMA_VERSION = 10;
