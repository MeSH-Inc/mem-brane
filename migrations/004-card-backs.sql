-- A placement may sit on the back of another placement on the same brane. It stays
-- a placement, so its block remains visible to the brane, but it is drawn on its
-- host's back instead of on the table. Backs are one level deep: a host is always on
-- the table. Removing the host removes what is on its back.
ALTER TABLE placements ADD COLUMN host_placement_id TEXT REFERENCES placements(id) ON DELETE CASCADE;
CREATE INDEX placements_host ON placements(host_placement_id);
CREATE TRIGGER placement_host_insert BEFORE INSERT ON placements
WHEN NEW.host_placement_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM placements host WHERE host.id=NEW.host_placement_id
  AND host.brane_id=NEW.brane_id AND host.host_placement_id IS NULL
) BEGIN SELECT RAISE(ABORT,'invalid placement host'); END;
CREATE TRIGGER placement_host_update BEFORE UPDATE OF host_placement_id ON placements
WHEN NEW.host_placement_id IS NOT NULL AND (NOT EXISTS (
  SELECT 1 FROM placements host WHERE host.id=NEW.host_placement_id
  AND host.brane_id=NEW.brane_id AND host.host_placement_id IS NULL AND host.id<>NEW.id
) OR EXISTS (SELECT 1 FROM placements hosted WHERE hosted.host_placement_id=NEW.id))
BEGIN SELECT RAISE(ABORT,'invalid placement host'); END;
