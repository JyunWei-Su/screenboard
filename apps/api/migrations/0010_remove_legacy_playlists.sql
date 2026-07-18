-- Internal-test breaking change: the legacy media-playlist model is removed.
-- Devices and schedules can now target only a scene or a scene group.
DELETE FROM schedules WHERE source_type = 'playlist';
UPDATE devices SET source_type = 'scene', scene_id = NULL WHERE source_type = 'playlist';

ALTER TABLE schedules DROP COLUMN playlist_id;
ALTER TABLE devices DROP COLUMN playlist_id;

DROP TABLE playlist_items;
DROP TABLE playlists;
