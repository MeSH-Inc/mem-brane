-- A purged guest is an irreversible tombstone. Claim and reclamation serialize
-- their decision in immediate transactions; retained rows keep deletion debt owned.
CREATE TRIGGER guest_purge_terminal BEFORE UPDATE ON guest_libraries
WHEN OLD.purged_at IS NOT NULL OR (NEW.purged_at IS NOT NULL AND NEW.claimed_by IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Purged guest libraries cannot be changed or claimed'); END;

ALTER TABLE guest_object_deletions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guest_object_deletions ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX guest_deletion_retry ON guest_object_deletions(next_attempt_at,storage_key);
CREATE INDEX guest_reclamation ON guest_libraries(expires_at,library_id)
WHERE claimed_by IS NULL AND purged_at IS NULL;

-- History remains immutable for all live and claimed libraries. The only deletion
-- exception is final reclamation of an unclaimed guest, after its recovery grace.
DROP TRIGGER immutable_revision_delete;
CREATE TRIGGER immutable_revision_delete BEFORE DELETE ON block_revisions
WHEN NOT EXISTS (
 SELECT 1 FROM blocks b JOIN guest_libraries g ON g.library_id=b.owner_id
 WHERE b.id=OLD.block_id AND g.purged_at IS NOT NULL AND g.claimed_by IS NULL
)
BEGIN SELECT RAISE(ABORT,'immutable revision'); END;

DROP TRIGGER immutable_representation_delete;
CREATE TRIGGER immutable_representation_delete BEFORE DELETE ON asset_representations
WHEN NOT EXISTS (
 SELECT 1 FROM assets a JOIN guest_libraries g ON g.library_id=a.owner_id
 WHERE a.id=OLD.asset_id AND g.purged_at IS NOT NULL AND g.claimed_by IS NULL
)
BEGIN SELECT RAISE(ABORT,'immutable representation'); END;

DROP TRIGGER immutable_summary_delete;
CREATE TRIGGER immutable_summary_delete BEFORE DELETE ON representation_summaries
WHEN NOT EXISTS (
 SELECT 1 FROM asset_representations r JOIN assets a ON a.id=r.asset_id
 JOIN guest_libraries g ON g.library_id=a.owner_id
 WHERE r.id=OLD.representation_id AND g.purged_at IS NOT NULL AND g.claimed_by IS NULL
)
BEGIN SELECT RAISE(ABORT,'immutable representation summary'); END;
