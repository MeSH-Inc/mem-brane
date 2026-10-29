-- A machine is an authored block whose text is a prompt template with {slot} names.
-- Widening the kind check rebuilds blocks; legacy renaming keeps the references that
-- other tables and triggers hold to "blocks" pointing at the rebuilt table.
CREATE TABLE blocks_next (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  kind TEXT NOT NULL CHECK(kind IN ('text','image','webpage','pdf','machine')),
  created_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'authored' CHECK(origin IN ('authored','generated')),
  CHECK(kind<>'machine' OR origin='authored')
);
INSERT INTO blocks_next (id,owner_id,kind,created_at,origin)
  SELECT id,owner_id,kind,created_at,origin FROM blocks;
DROP TABLE blocks;
PRAGMA legacy_alter_table=ON;
ALTER TABLE blocks_next RENAME TO blocks;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX blocks_library_history ON blocks(owner_id,created_at DESC,id DESC);
CREATE TRIGGER block_identity_update BEFORE UPDATE OF kind,origin ON blocks BEGIN SELECT RAISE(ABORT, 'Immutable artifact format and origin'); END;

-- A feed declares that one placed card fills one slot of a placed machine on the same
-- brane. Feeds are persisted semantics, never executed: a run sends its inputs
-- explicitly and freezes them. Removing either placement removes the feed.
CREATE TABLE feeds (
  id TEXT PRIMARY KEY,
  brane_id TEXT NOT NULL REFERENCES branes(id),
  from_placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  to_placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK(length(slot) BETWEEN 1 AND 40),
  created_at INTEGER NOT NULL,
  CHECK(from_placement_id<>to_placement_id),
  UNIQUE(from_placement_id,to_placement_id,slot)
);
CREATE INDEX feeds_brane ON feeds(brane_id);
CREATE INDEX feeds_target ON feeds(to_placement_id);
CREATE TRIGGER feeds_valid_endpoints BEFORE INSERT ON feeds
WHEN NOT EXISTS (
  SELECT 1 FROM placements source JOIN placements target ON target.id=NEW.to_placement_id
  JOIN blocks machine ON machine.id=target.block_id JOIN blocks fed ON fed.id=source.block_id
  WHERE source.id=NEW.from_placement_id AND source.brane_id=NEW.brane_id
  AND target.brane_id=NEW.brane_id AND machine.kind='machine' AND fed.kind<>'machine'
) BEGIN SELECT RAISE(ABORT,'invalid feed endpoints'); END;
CREATE TRIGGER immutable_feed BEFORE UPDATE ON feeds BEGIN SELECT RAISE(ABORT,'immutable feed'); END;
