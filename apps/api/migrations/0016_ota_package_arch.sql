-- Track the CPU architecture each OTA package targets so the admin UI can show
-- it and the update check can serve devices the matching binary. Nullable:
-- packages uploaded before this migration have no recorded arch (shown as
-- unknown) and are excluded from arch-filtered update matching.
ALTER TABLE ota_packages ADD COLUMN arch TEXT;
