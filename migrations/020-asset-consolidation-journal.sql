-- Offline preflight can create this journal before 015; normal migrations retain it.
CREATE TABLE IF NOT EXISTS asset_consolidation_journal (
 old_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL REFERENCES assets(id), storage_key TEXT NOT NULL UNIQUE,
 digest TEXT NOT NULL,size INTEGER NOT NULL,backup_fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','deleting','deleted'))
);

CREATE TRIGGER IF NOT EXISTS immutable_consolidation_record BEFORE UPDATE OF old_id,canonical_id,storage_key,digest,size,backup_fingerprint ON asset_consolidation_journal
BEGIN SELECT RAISE(ABORT,'immutable consolidation record'); END;
CREATE TRIGGER IF NOT EXISTS consolidation_state_transition BEFORE UPDATE OF state ON asset_consolidation_journal
WHEN NOT ((OLD.state='pending' AND NEW.state='deleting') OR (OLD.state='deleting' AND NEW.state IN ('deleting','deleted')))
BEGIN SELECT RAISE(ABORT,'invalid consolidation transition'); END;
