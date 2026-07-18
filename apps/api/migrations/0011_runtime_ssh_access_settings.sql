-- Runtime-managed SSH Access settings. Values here override deployment-time
-- defaults, so operators can update allowed identities without a Worker deploy.
CREATE TABLE system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
