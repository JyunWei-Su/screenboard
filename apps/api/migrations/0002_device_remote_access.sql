-- Per-device Cloudflare Tunnel / Access metadata. Tunnel tokens are deliberately
-- not persisted: the device retrieves a fresh management token during bootstrap.
CREATE TABLE device_remote_access (
  device_id     TEXT PRIMARY KEY REFERENCES devices(uuid) ON DELETE CASCADE,
  tunnel_id     TEXT NOT NULL UNIQUE,
  access_app_id TEXT,
  hostname      TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'inactive', -- inactive|healthy|degraded|down|error
  last_error    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_remote_access_status ON device_remote_access(status);
