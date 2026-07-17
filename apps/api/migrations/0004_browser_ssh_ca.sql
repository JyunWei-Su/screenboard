-- Browser-rendered SSH uses an Access application-specific short-lived CA.
-- Existing rows remain on provisioning version 2 and are explicitly re-provisioned.
ALTER TABLE device_remote_access ADD COLUMN ssh_ca_public_key TEXT;
