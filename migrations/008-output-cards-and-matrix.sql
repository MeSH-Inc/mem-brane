-- A machine whose prompt declares "Output: cards" or "Output: diagram" has its answer
-- placed as one generated card per numbered item. The run's output stays one block with
-- the whole answer; each part is a further generated block with one revision, the
-- item's text, produced by the same run and so derived from the same frozen inputs.
CREATE TABLE run_parts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
  block_id TEXT NOT NULL UNIQUE REFERENCES blocks(id),
  revision_id TEXT NOT NULL UNIQUE REFERENCES block_revisions(id),
  PRIMARY KEY(run_id,position)
);
CREATE TRIGGER run_part_valid BEFORE INSERT ON run_parts
WHEN NOT EXISTS (
  SELECT 1 FROM runs r JOIN blocks b ON b.id=NEW.block_id JOIN block_revisions v ON v.id=NEW.revision_id
  WHERE r.id=NEW.run_id AND r.status='completed' AND b.owner_id=r.owner_id
  AND b.origin='generated' AND b.kind='text' AND v.block_id=b.id AND b.id<>r.output_block_id
) BEGIN SELECT RAISE(ABORT,'invalid run part'); END;
CREATE TRIGGER immutable_run_part_update BEFORE UPDATE ON run_parts BEGIN SELECT RAISE(ABORT,'immutable run part'); END;
CREATE TRIGGER immutable_run_part_delete BEFORE DELETE ON run_parts BEGIN SELECT RAISE(ABORT,'immutable run part'); END;

-- A third display: the outputs of machines run each over one stack, as a table with a
-- row per card of the stack and a column per machine.
CREATE TABLE groups_next (
  id TEXT PRIMARY KEY,
  brane_id TEXT NOT NULL REFERENCES branes(id),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 60),
  display TEXT NOT NULL CHECK(display IN ('region','stack','matrix')),
  created_at INTEGER NOT NULL
);
INSERT INTO groups_next SELECT id,brane_id,label,display,created_at FROM groups;
DROP TABLE groups;
PRAGMA legacy_alter_table=ON;
ALTER TABLE groups_next RENAME TO groups;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX groups_brane ON groups(brane_id);
