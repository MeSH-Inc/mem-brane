-- Rebuild the format constraint. Migration runner validates all foreign keys before commit.
CREATE TABLE blocks_next (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  kind TEXT NOT NULL CHECK(kind IN ('text','image','webpage','pdf')),
  created_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'authored' CHECK(origin IN ('authored','generated'))
);
INSERT INTO blocks_next SELECT id,owner_id,kind,created_at,origin FROM blocks;
DROP TABLE blocks;
ALTER TABLE blocks_next RENAME TO blocks;
CREATE TRIGGER block_identity_update BEFORE UPDATE OF kind,origin ON blocks BEGIN SELECT RAISE(ABORT, 'Immutable artifact format and origin'); END;
