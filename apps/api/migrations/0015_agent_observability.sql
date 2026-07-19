-- Agent 0.2 runtime observability and capability discovery. Nullable fields
-- preserve compatibility with the existing fleet while devices update gradually.
ALTER TABLE devices ADD COLUMN protocol_version INTEGER;
ALTER TABLE devices ADD COLUMN agent_capabilities TEXT;

ALTER TABLE device_health_latest ADD COLUMN temperature REAL;
ALTER TABLE device_health_latest ADD COLUMN chromium_status TEXT;
ALTER TABLE device_health_latest ADD COLUMN browser_restart_count INTEGER;
ALTER TABLE device_health_latest ADD COLUMN browser_last_exit_at TEXT;
ALTER TABLE device_health_latest ADD COLUMN last_sync_success_at TEXT;
ALTER TABLE device_health_latest ADD COLUMN cache_used_bytes INTEGER;
ALTER TABLE device_health_latest ADD COLUMN cache_limit_bytes INTEGER;

ALTER TABLE device_health_history ADD COLUMN temperature REAL;
ALTER TABLE device_health_history ADD COLUMN chromium_status TEXT;
ALTER TABLE device_health_history ADD COLUMN browser_restart_count INTEGER;
ALTER TABLE device_health_history ADD COLUMN browser_last_exit_at TEXT;
ALTER TABLE device_health_history ADD COLUMN last_sync_success_at TEXT;
ALTER TABLE device_health_history ADD COLUMN cache_used_bytes INTEGER;
ALTER TABLE device_health_history ADD COLUMN cache_limit_bytes INTEGER;
