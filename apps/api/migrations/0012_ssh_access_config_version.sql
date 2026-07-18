-- Tracks which managed SSH Access email-list revision was applied to each
-- Cloudflare Access application, enabling safe automatic reprovisioning.
ALTER TABLE device_remote_access ADD COLUMN access_config_version INTEGER NOT NULL DEFAULT 0;
