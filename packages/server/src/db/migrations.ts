import type { DB } from "../db.js";

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

CREATE TABLE IF NOT EXISTS reposts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, event_id)
);

CREATE TABLE IF NOT EXISTS auto_reposts (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, source_account_id)
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
CREATE INDEX IF NOT EXISTS idx_reposts_account ON reposts(account_id);
CREATE INDEX IF NOT EXISTS idx_reposts_event ON reposts(event_id);
CREATE INDEX IF NOT EXISTS idx_auto_reposts_account ON auto_reposts(account_id);
CREATE INDEX IF NOT EXISTS idx_auto_reposts_source ON auto_reposts(source_account_id);
CREATE INDEX IF NOT EXISTS idx_actor_selection_ops_initiated_by ON actor_selection_operations(initiated_by_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_actor_selection_items_operation ON actor_selection_operation_items(operation_id);
CREATE INDEX IF NOT EXISTS idx_saved_locations_account ON saved_locations(account_id, used_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_reminder_sent_account ON event_reminder_sent(account_id);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline_schema",
    up: (db) => {
      db.exec(BASELINE_SCHEMA_SQL);
    },
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
