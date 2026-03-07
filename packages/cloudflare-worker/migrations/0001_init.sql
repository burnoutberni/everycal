CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  account_type TEXT NOT NULL DEFAULT 'person' CHECK(account_type IN ('person','identity')),
  display_name TEXT,
  bio TEXT,
  avatar_url TEXT,
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','unlisted','followers_only','private')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_account_start ON events(account_id, start_date);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  created_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS identity_memberships (
  identity_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  member_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','editor')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (identity_account_id, member_account_id)
);

CREATE TABLE IF NOT EXISTS remote_follows (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  follower_actor_uri TEXT NOT NULL,
  follower_inbox TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, follower_actor_uri)
);


CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

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

CREATE INDEX IF NOT EXISTS idx_saved_locations_account ON saved_locations(account_id, used_at DESC);


CREATE TABLE IF NOT EXISTS remote_actors (
  uri TEXT PRIMARY KEY,
  preferred_username TEXT NOT NULL,
  display_name TEXT,
  inbox TEXT,
  icon_url TEXT,
  domain TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_remote_actors_domain ON remote_actors(domain);

CREATE TABLE IF NOT EXISTS remote_events (
  uri TEXT PRIMARY KEY,
  actor_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_remote_events_actor ON remote_events(actor_uri);
CREATE INDEX IF NOT EXISTS idx_remote_events_start ON remote_events(start_date);


CREATE TABLE IF NOT EXISTS remote_following (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor_uri TEXT NOT NULL,
  actor_inbox TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, actor_uri)
);

CREATE INDEX IF NOT EXISTS idx_remote_following_account ON remote_following(account_id);
