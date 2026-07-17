-- ScreenBoard initial schema (D1 / SQLite)

-- ---- Groups (Site / Building / Floor / Department / Custom), adjacency-list tree ----
CREATE TABLE groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'custom',
  parent_id  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_groups_parent ON groups(parent_id);

-- ---- Users (single-TOTP login, no password) ----
CREATE TABLE users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  totp_secret  TEXT NOT NULL,               -- base32, application-encrypted at rest
  role         TEXT NOT NULL DEFAULT 'viewer', -- admin | operator | viewer
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Session revocation list (JWTs carry jti; a row here = revoked/active session record)
CREATE TABLE sessions (
  token_id   TEXT PRIMARY KEY,              -- jti
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---- Enrollment tokens (one-time, group-bound) ----
CREATE TABLE enrollment_tokens (
  token       TEXT PRIMARY KEY,
  group_id    INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  expires_at  TEXT NOT NULL,
  used_by_uuid TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Devices ----
CREATE TABLE devices (
  uuid          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  hostname      TEXT,
  serial        TEXT,
  os_version    TEXT,
  agent_version TEXT,
  ip            TEXT,
  mac           TEXT,
  resolution    TEXT,
  group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'offline', -- online|offline|warning|maintenance
  playlist_id   INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
  display       TEXT NOT NULL DEFAULT '{"kiosk":true,"zoom":1,"rotate":0,"screen":0}', -- JSON DisplaySettings
  refresh_token TEXT,                         -- hashed refresh token for the device
  last_seen_at  TEXT,
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_devices_group ON devices(group_id);
CREATE INDEX idx_devices_status ON devices(status);

-- ---- Health ----
CREATE TABLE device_health_latest (
  device_id TEXT PRIMARY KEY REFERENCES devices(uuid) ON DELETE CASCADE,
  cpu       REAL,
  memory    REAL,
  disk      REAL,
  net_ok    INTEGER,
  uptime    INTEGER,
  ts        TEXT NOT NULL
);

CREATE TABLE device_health_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  cpu       REAL,
  memory    REAL,
  disk      REAL,
  net_ok    INTEGER,
  uptime    INTEGER,
  ts        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_health_hist_device_ts ON device_health_history(device_id, ts);
CREATE INDEX idx_health_hist_ts ON device_health_history(ts);

-- ---- Media library ----
CREATE TABLE media (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  filename           TEXT NOT NULL,
  type               TEXT NOT NULL,   -- image|video|pdf|html
  content_type       TEXT,
  current_version_id INTEGER,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE media_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  size        INTEGER,
  checksum    TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_media_versions_media ON media_versions(media_id);

CREATE TABLE media_tags (
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (media_id, tag)
);

-- ---- Playlists ----
CREATE TABLE playlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  loop       INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE playlist_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id  INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,          -- url|image|video|pdf|html
  url          TEXT,                   -- for type=url/html(external)
  media_id     INTEGER REFERENCES media(id) ON DELETE SET NULL,
  duration_sec INTEGER NOT NULL DEFAULT 10,
  order_index  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id, order_index);

-- ---- Schedules ----
CREATE TABLE schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id  INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,          -- device | group
  target_id    TEXT NOT NULL,          -- device uuid or group id
  date_start   TEXT,                   -- YYYY-MM-DD (nullable = always)
  date_end     TEXT,
  time_start   TEXT,                   -- HH:MM (nullable = all day)
  time_end     TEXT,
  weekdays     INTEGER NOT NULL DEFAULT 127, -- bitmask, bit0=Sun .. bit6=Sat
  priority     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_schedules_target ON schedules(target_type, target_id);

-- ---- Screenshots ----
CREATE TABLE screenshots (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  r2_key    TEXT NOT NULL,
  trigger   TEXT NOT NULL DEFAULT 'auto', -- auto | manual
  analysis  TEXT,                          -- e.g. black_screen / ok / error
  taken_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_screenshots_device ON screenshots(device_id, taken_at);

-- ---- OTA ----
CREATE TABLE ota_packages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL DEFAULT 'stable', -- stable | beta
  version    TEXT NOT NULL,
  r2_key     TEXT NOT NULL,
  checksum   TEXT NOT NULL,        -- sha256 hex
  signature  TEXT,                 -- base64 ed25519 signature of checksum
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ota_channel ON ota_packages(channel, created_at);

CREATE TABLE ota_deployments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id INTEGER NOT NULL REFERENCES ota_packages(id) ON DELETE CASCADE,
  strategy   TEXT NOT NULL DEFAULT 'all',    -- all | group | canary
  target     TEXT,                            -- group id when strategy=group
  percent    INTEGER NOT NULL DEFAULT 100,    -- canary rollout percentage
  status     TEXT NOT NULL DEFAULT 'active',  -- active | paused | done
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Commands (audit) ----
CREATE TABLE commands (
  id        TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
  type      TEXT NOT NULL,
  payload   TEXT,
  status    TEXT NOT NULL DEFAULT 'queued', -- queued | sent | acked | failed
  detail    TEXT,
  issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  acked_at  TEXT
);
CREATE INDEX idx_commands_device ON commands(device_id, issued_at);

-- ---- Events / alerts ----
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  device_id   TEXT REFERENCES devices(uuid) ON DELETE CASCADE,
  severity    TEXT NOT NULL DEFAULT 'info',
  message     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_events_created ON events(created_at);
CREATE INDEX idx_events_device ON events(device_id);

-- ---- Notification channels ----
CREATE TABLE notification_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,   -- teams | webhook
  url         TEXT NOT NULL,
  events      TEXT NOT NULL DEFAULT '*', -- comma list of EventType or '*'
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Playback counters (for dashboard content-usage stats) ----
CREATE TABLE playback_counters (
  media_id  INTEGER,
  playlist_id INTEGER,
  day       TEXT NOT NULL,     -- YYYY-MM-DD
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (playlist_id, media_id, day)
);
