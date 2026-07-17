-- Per-device polling and maintenance intervals, managed from the admin console.
ALTER TABLE devices ADD COLUMN agent_settings TEXT NOT NULL DEFAULT '{"health_interval_sec":60,"playlist_poll_sec":30,"screenshot_interval_sec":0,"ota_check_sec":1800}';
