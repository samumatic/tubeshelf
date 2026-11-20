-- All timestamps are unix seconds.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  oidc_issuer   TEXT,
  oidc_subject  TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX users_oidc ON users(oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE oidc_providers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  issuer         TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  client_secret  TEXT NOT NULL, -- AES-GCM encrypted, see auth/secret.go
  scopes         TEXT NOT NULL DEFAULT 'openid profile email',
  auto_provision INTEGER NOT NULL DEFAULT 0,
  group_claim    TEXT NOT NULL DEFAULT '',
  admin_group    TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;

-- One row per YouTube channel, shared by all users.
CREATE TABLE channels (
  id              TEXT PRIMARY KEY, -- UC...
  title           TEXT NOT NULL,
  thumbnail       TEXT NOT NULL DEFAULT '',
  next_fetch_at   INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_error      TEXT NOT NULL DEFAULT '',
  fail_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX channels_next_fetch ON channels(next_fetch_at);

CREATE TABLE subscriptions (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
) WITHOUT ROWID;
CREATE INDEX subscriptions_channel ON subscriptions(channel_id);

CREATE TABLE lists (
  id      INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE list_channels (
  list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, channel_id)
) WITHOUT ROWID;

CREATE TABLE videos (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL, -- no FK: saved videos outlive a subscription
  channel_title    TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL,
  published_at     INTEGER NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'video', -- video | short | live | upcoming
  duration_seconds INTEGER,                       -- NULL until enriched
  members_only     INTEGER NOT NULL DEFAULT 0,
  enrich_after     INTEGER NOT NULL DEFAULT 0,    -- 0 = done, else earliest retry time
  enrich_attempts  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX videos_feed ON videos(channel_id, published_at DESC);
CREATE INDEX videos_published ON videos(published_at DESC);
CREATE INDEX videos_enrich ON videos(enrich_after) WHERE enrich_after > 0;

-- Progress and watched flag in one row per user and video.
CREATE TABLE watch_state (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id   TEXT NOT NULL,
  progress   REAL NOT NULL DEFAULT 0, -- seconds
  watched    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
) WITHOUT ROWID;
CREATE INDEX watch_state_recent ON watch_state(user_id, updated_at DESC);

CREATE TABLE watch_later (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, video_id)
) WITHOUT ROWID;
