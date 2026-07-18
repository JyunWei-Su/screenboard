-- Device groups become a flat, untyped list: no nesting (parent_id) and no type
-- classification. Any former parent/child relationship is discarded; every group
-- becomes a top-level group. Devices keep their group_id assignment.
DROP INDEX IF EXISTS idx_groups_parent;
ALTER TABLE groups DROP COLUMN parent_id;
ALTER TABLE groups DROP COLUMN type;
