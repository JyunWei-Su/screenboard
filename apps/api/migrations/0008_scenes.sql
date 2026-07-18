-- ScreenBoard scene playback architecture (D1 / SQLite)
-- Adds the Scene model on top of the existing playlist model. Existing playlist
-- tables and behaviour are left intact for the migration period (see TODO.md D).

-- ---- Scenes: a full canvas layout composed of multiple widgets ----
CREATE TABLE scenes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  width             INTEGER NOT NULL DEFAULT 1920,
  height            INTEGER NOT NULL DEFAULT 1080,
  background        TEXT NOT NULL DEFAULT '{"color":"#000000"}', -- JSON SceneBackground {color?, media_id?}
  status            TEXT NOT NULL DEFAULT 'draft',   -- draft | published
  published_version INTEGER,                          -- scene_versions.version currently live (NULL until first publish)
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- Scene widgets: the editable DRAFT set of widgets for a scene ----
-- config is a per-kind JSON blob; the authoritative schema lives in
-- packages/shared/src/index.ts (WidgetConfig union). kind is one of:
--   image | video | web | text | ticker | direction | clock
CREATE TABLE scene_widgets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id   INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  x          INTEGER NOT NULL DEFAULT 0,
  y          INTEGER NOT NULL DEFAULT 0,
  width      INTEGER NOT NULL DEFAULT 320,
  height     INTEGER NOT NULL DEFAULT 240,
  z          INTEGER NOT NULL DEFAULT 0,       -- z-index / layer order
  visible    INTEGER NOT NULL DEFAULT 1,
  locked     INTEGER NOT NULL DEFAULT 0,
  config     TEXT NOT NULL DEFAULT '{}',       -- JSON WidgetConfig
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scene_widgets_scene ON scene_widgets(scene_id, z);

-- ---- Scene versions: immutable published snapshots (never overwritten) ----
-- snapshot holds the entire resolved-independent scene: {width,height,background,widgets:[...]}
CREATE TABLE scene_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_id     INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,               -- incrementing per scene, starting at 1
  snapshot     TEXT NOT NULL,                  -- JSON snapshot of canvas + widgets
  revision     TEXT NOT NULL,                  -- content hash for client cache comparison
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scene_id, version)
);
CREATE INDEX idx_scene_versions_scene ON scene_versions(scene_id, version);

-- ---- Scene playlists: rotate full scenes (not single media) ----
CREATE TABLE scene_playlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  loop       INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scene_playlist_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_playlist_id INTEGER NOT NULL REFERENCES scene_playlists(id) ON DELETE CASCADE,
  scene_id          INTEGER NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  dwell_sec         INTEGER NOT NULL DEFAULT 15,
  order_index       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_scene_playlist_items_pl ON scene_playlist_items(scene_playlist_id, order_index);

-- ---- Extend targeting so a schedule can point at a playlist, scene, or scene playlist ----
-- SQLite can't drop the old NOT NULL on schedules.playlist_id in place, so rebuild
-- the table. Existing rows migrate to source_type='playlist' unchanged.
CREATE TABLE schedules_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type       TEXT NOT NULL DEFAULT 'playlist', -- playlist | scene | scene_playlist
  playlist_id       INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
  scene_id          INTEGER REFERENCES scenes(id) ON DELETE CASCADE,
  scene_playlist_id INTEGER REFERENCES scene_playlists(id) ON DELETE CASCADE,
  target_type       TEXT NOT NULL,          -- device | group
  target_id         TEXT NOT NULL,          -- device uuid or group id
  date_start        TEXT,
  date_end          TEXT,
  time_start        TEXT,
  time_end          TEXT,
  weekdays          INTEGER NOT NULL DEFAULT 127,
  priority          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO schedules_new
  (id, source_type, playlist_id, target_type, target_id,
   date_start, date_end, time_start, time_end, weekdays, priority, created_at)
  SELECT id, 'playlist', playlist_id, target_type, target_id,
         date_start, date_end, time_start, time_end, weekdays, priority, created_at
  FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;
CREATE INDEX idx_schedules_target ON schedules(target_type, target_id);

-- ---- Extend devices with a default scene / scene-playlist assignment ----
-- Existing devices keep source_type='playlist' + playlist_id, so behaviour is unchanged.
ALTER TABLE devices ADD COLUMN source_type TEXT NOT NULL DEFAULT 'playlist'; -- playlist | scene | scene_playlist
ALTER TABLE devices ADD COLUMN scene_id INTEGER REFERENCES scenes(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN scene_playlist_id INTEGER REFERENCES scene_playlists(id) ON DELETE SET NULL;
