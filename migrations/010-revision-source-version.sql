-- A live-state version has exactly one immutable materialization. Older snapshots
-- have no recorded source version; do not invent one or rewrite historical IDs.
ALTER TABLE block_revisions ADD COLUMN source_version INTEGER CHECK(source_version >= 0);
CREATE UNIQUE INDEX revisions_source_version ON block_revisions(block_id, source_version)
WHERE source_version IS NOT NULL;
