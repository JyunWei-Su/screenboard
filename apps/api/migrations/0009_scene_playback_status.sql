-- Last scene context reported by the player. Kept on devices so the admin UI
-- and a captured screenshot can be correlated with the rendered revision.
ALTER TABLE devices ADD COLUMN active_scene_id INTEGER;
ALTER TABLE devices ADD COLUMN active_scene_version INTEGER;
ALTER TABLE devices ADD COLUMN widget_errors TEXT;
ALTER TABLE devices ADD COLUMN playback_updated_at TEXT;
ALTER TABLE screenshots ADD COLUMN scene_id INTEGER;
ALTER TABLE screenshots ADD COLUMN scene_version INTEGER;
ALTER TABLE screenshots ADD COLUMN widget_errors TEXT;
