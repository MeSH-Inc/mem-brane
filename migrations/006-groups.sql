-- A group is a labelled, ordered set of cards on the table that moves as one and can
-- feed a machine slot as one. Its display (a region around the cards, or a stack of
-- them) is presentation; a feed from a group sends its members in member order. A card
-- belongs to at most one group, and a group whose last member is removed goes with it.
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  brane_id TEXT NOT NULL REFERENCES branes(id),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 60),
  display TEXT NOT NULL CHECK(display IN ('region','stack')),
  created_at INTEGER NOT NULL
);
CREATE INDEX groups_brane ON groups(brane_id);
CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  placement_id TEXT NOT NULL UNIQUE REFERENCES placements(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
  PRIMARY KEY(group_id,placement_id)
);
-- Members are cards, not machines, on the table of the group's brane.
CREATE TRIGGER group_member_insert BEFORE INSERT ON group_members
WHEN NOT EXISTS (
  SELECT 1 FROM placements p JOIN groups g ON g.id=NEW.group_id JOIN blocks b ON b.id=p.block_id
  WHERE p.id=NEW.placement_id AND p.brane_id=g.brane_id AND p.host_placement_id IS NULL
  AND b.kind<>'machine'
) BEGIN SELECT RAISE(ABORT,'invalid group member'); END;
CREATE TRIGGER group_member_update BEFORE UPDATE ON group_members
WHEN NEW.group_id<>OLD.group_id OR NOT EXISTS (
  SELECT 1 FROM placements p JOIN groups g ON g.id=NEW.group_id JOIN blocks b ON b.id=p.block_id
  WHERE p.id=NEW.placement_id AND p.brane_id=g.brane_id AND p.host_placement_id IS NULL
  AND b.kind<>'machine'
) BEGIN SELECT RAISE(ABORT,'invalid group member'); END;
CREATE TRIGGER group_emptied AFTER DELETE ON group_members
WHEN NOT EXISTS (SELECT 1 FROM group_members WHERE group_id=OLD.group_id)
BEGIN DELETE FROM groups WHERE id=OLD.group_id; END;

-- A feed comes from exactly one card or one group. Rows keep their rowid, which is
-- feed order within a slot.
CREATE TABLE feeds_next (
  id TEXT PRIMARY KEY,
  brane_id TEXT NOT NULL REFERENCES branes(id),
  from_placement_id TEXT REFERENCES placements(id) ON DELETE CASCADE,
  from_group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  to_placement_id TEXT NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK(length(slot) BETWEEN 1 AND 40),
  created_at INTEGER NOT NULL,
  CHECK((from_placement_id IS NULL)<>(from_group_id IS NULL)),
  CHECK(from_placement_id IS NULL OR from_placement_id<>to_placement_id),
  UNIQUE(from_placement_id,to_placement_id,slot),
  UNIQUE(from_group_id,to_placement_id,slot)
);
INSERT INTO feeds_next (rowid,id,brane_id,from_placement_id,from_group_id,to_placement_id,slot,created_at)
SELECT rowid,id,brane_id,from_placement_id,NULL,to_placement_id,slot,created_at FROM feeds;
DROP TABLE feeds;
PRAGMA legacy_alter_table=ON;
ALTER TABLE feeds_next RENAME TO feeds;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX feeds_brane ON feeds(brane_id);
CREATE INDEX feeds_target ON feeds(to_placement_id);
CREATE INDEX feeds_group ON feeds(from_group_id);
CREATE TRIGGER feeds_valid_endpoints BEFORE INSERT ON feeds
WHEN NOT EXISTS (
  SELECT 1 FROM placements target JOIN blocks machine ON machine.id=target.block_id
  WHERE target.id=NEW.to_placement_id AND target.brane_id=NEW.brane_id AND machine.kind='machine'
) OR (NEW.from_placement_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM placements source JOIN blocks fed ON fed.id=source.block_id
  WHERE source.id=NEW.from_placement_id AND source.brane_id=NEW.brane_id AND fed.kind<>'machine'
)) OR (NEW.from_group_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM groups WHERE id=NEW.from_group_id AND brane_id=NEW.brane_id
)) BEGIN SELECT RAISE(ABORT,'invalid feed endpoints'); END;
CREATE TRIGGER immutable_feed BEFORE UPDATE ON feeds BEGIN SELECT RAISE(ABORT,'immutable feed'); END;

-- An arrow's word may now change; its identity, brane and creation time still may not.
DROP TRIGGER relation_update;
CREATE TRIGGER relation_update BEFORE UPDATE ON relations
WHEN NEW.id<>OLD.id OR NEW.brane_id<>OLD.brane_id OR NEW.created_at<>OLD.created_at
OR NOT EXISTS (
  SELECT 1 FROM placements source JOIN placements target ON target.id=NEW.to_placement_id
  WHERE source.id=NEW.from_placement_id AND source.brane_id=NEW.brane_id
  AND target.brane_id=NEW.brane_id
  AND source.host_placement_id IS NULL AND target.host_placement_id IS NULL
) BEGIN SELECT RAISE(ABORT,'invalid relation update'); END;

-- The structure of a relation entry: the two entries of the same context it joins and
-- the arrow's word, so a workspace can compare the arrows a run sent with the arrows
-- drawn now. It is sealed with its context.
CREATE TABLE relation_entries (
  context_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  from_position INTEGER NOT NULL,
  to_position INTEGER NOT NULL,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 60),
  PRIMARY KEY(context_id,position),
  FOREIGN KEY(context_id,position) REFERENCES context_entries(context_id,position)
);
CREATE TRIGGER relation_entry_valid BEFORE INSERT ON relation_entries
WHEN EXISTS (SELECT 1 FROM runs WHERE context_id=NEW.context_id)
OR NOT EXISTS (
  SELECT 1 FROM context_entries WHERE context_id=NEW.context_id AND position=NEW.position
  AND kind='relation'
) OR NOT EXISTS (
  SELECT 1 FROM context_entries WHERE context_id=NEW.context_id AND position=NEW.from_position
  AND kind IN ('source','reference')
) OR NOT EXISTS (
  SELECT 1 FROM context_entries WHERE context_id=NEW.context_id AND position=NEW.to_position
  AND kind IN ('source','reference')
) BEGIN SELECT RAISE(ABORT,'invalid relation entry'); END;
CREATE TRIGGER immutable_relation_entry_update BEFORE UPDATE ON relation_entries BEGIN SELECT RAISE(ABORT,'immutable relation entry'); END;
CREATE TRIGGER immutable_relation_entry_delete BEFORE DELETE ON relation_entries BEGIN SELECT RAISE(ABORT,'immutable relation entry'); END;
