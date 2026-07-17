-- Version 2 uses a self-hosted public Access application, which is required
-- for Cloudflare browser-rendered SSH. Existing rows remain version 1 so the
-- admin console can offer a safe explicit reprovision action.
ALTER TABLE device_remote_access ADD COLUMN provisioning_version INTEGER NOT NULL DEFAULT 1;
