-- A relation is an arrow on the table: how one placed card stands to another, in the
-- user's word ("answers", "supports"). Relations are persisted semantics, never
-- executed; a run whose inputs include both ends freezes the relation as an entry.
-- Removing either placement removes the relation.
CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  brane_id TEXT NOT NULL REFERENCES branes(id),
  from_placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  to_placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 60),
  created_at INTEGER NOT NULL,
  CHECK(from_placement_id<>to_placement_id),
  UNIQUE(from_placement_id,to_placement_id)
);
CREATE INDEX relations_brane ON relations(brane_id);
CREATE INDEX relations_target ON relations(to_placement_id);
-- Both ends are on the table of the relation's brane. A machine rerun moves the ends
-- it replaces onto the new output, so only the endpoints may change.
CREATE TRIGGER relation_insert BEFORE INSERT ON relations
WHEN NOT EXISTS (
  SELECT 1 FROM placements source JOIN placements target ON target.id=NEW.to_placement_id
  WHERE source.id=NEW.from_placement_id AND source.brane_id=NEW.brane_id
  AND target.brane_id=NEW.brane_id
  AND source.host_placement_id IS NULL AND target.host_placement_id IS NULL
) BEGIN SELECT RAISE(ABORT,'invalid relation endpoints'); END;
CREATE TRIGGER relation_update BEFORE UPDATE ON relations
WHEN NEW.id<>OLD.id OR NEW.brane_id<>OLD.brane_id OR NEW.label<>OLD.label
OR NEW.created_at<>OLD.created_at OR NOT EXISTS (
  SELECT 1 FROM placements source JOIN placements target ON target.id=NEW.to_placement_id
  WHERE source.id=NEW.from_placement_id AND source.brane_id=NEW.brane_id
  AND target.brane_id=NEW.brane_id
  AND source.host_placement_id IS NULL AND target.host_placement_id IS NULL
) BEGIN SELECT RAISE(ABORT,'invalid relation update'); END;

-- A run's context may carry relation entries: frozen text naming two of its inputs.
CREATE TABLE context_entries_next (
  context_id TEXT NOT NULL REFERENCES context_manifests(id),
  position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
  kind TEXT NOT NULL CHECK(kind IN ('source','reference','relation','prompt')),
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role='user'),
  revision_id TEXT NOT NULL REFERENCES block_revisions(id),
  PRIMARY KEY(context_id,position)
);
INSERT INTO context_entries_next SELECT * FROM context_entries;
DROP TABLE context_entries;
PRAGMA legacy_alter_table=ON;
ALTER TABLE context_entries_next RENAME TO context_entries;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX context_entries_revision ON context_entries(revision_id);
CREATE TRIGGER immutable_context_entry_update BEFORE UPDATE ON context_entries BEGIN SELECT RAISE(ABORT,'immutable context entry'); END;
CREATE TRIGGER immutable_context_entry_delete BEFORE DELETE ON context_entries BEGIN SELECT RAISE(ABORT,'immutable context entry'); END;
CREATE TRIGGER sealed_context_entry BEFORE INSERT ON context_entries
WHEN EXISTS (SELECT 1 FROM runs WHERE context_id=NEW.context_id)
BEGIN SELECT RAISE(ABORT,'sealed context'); END;
CREATE TRIGGER owned_context_entry BEFORE INSERT ON context_entries
WHEN NOT EXISTS (
  SELECT 1 FROM context_manifests c JOIN block_revisions v ON v.id=NEW.revision_id
  JOIN blocks b ON b.id=v.block_id WHERE c.id=NEW.context_id AND c.owner_id=b.owner_id
) BEGIN SELECT RAISE(ABORT,'invalid context revision'); END;
