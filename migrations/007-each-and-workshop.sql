-- A group feed may run its machine once per card ('each') instead of once with all of
-- them ('together'). The mode is the only part of a feed that may change.
ALTER TABLE feeds ADD COLUMN mode TEXT NOT NULL DEFAULT 'together' CHECK(mode IN ('together','each'));
DROP TRIGGER immutable_feed;
CREATE TRIGGER immutable_feed BEFORE UPDATE ON feeds
WHEN NEW.id IS NOT OLD.id OR NEW.brane_id IS NOT OLD.brane_id
OR NEW.from_placement_id IS NOT OLD.from_placement_id OR NEW.from_group_id IS NOT OLD.from_group_id
OR NEW.to_placement_id IS NOT OLD.to_placement_id OR NEW.slot IS NOT OLD.slot
OR NEW.created_at IS NOT OLD.created_at OR (NEW.mode='each' AND NEW.from_group_id IS NULL)
BEGIN SELECT RAISE(ABORT,'immutable feed'); END;
CREATE TRIGGER feed_each_insert BEFORE INSERT ON feeds
WHEN NEW.mode='each' AND NEW.from_group_id IS NULL
BEGIN SELECT RAISE(ABORT,'only a group feed runs each'); END;

-- The runs one press admitted together: one per card of the slot fed 'each', at its
-- position in that slot. A retry joins its run's batch at the same position.
CREATE TABLE run_batches (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  batch_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0)
);
CREATE INDEX run_batches_batch ON run_batches(batch_id);
CREATE TRIGGER immutable_run_batch_update BEFORE UPDATE ON run_batches BEGIN SELECT RAISE(ABORT,'immutable run batch'); END;
CREATE TRIGGER immutable_run_batch_delete BEFORE DELETE ON run_batches BEGIN SELECT RAISE(ABORT,'immutable run batch'); END;

-- The Workshop: machine prompts an account keeps to take out onto any brane. Taking one
-- out places a new machine with a copy of the prompt; the item itself is never placed.
CREATE TABLE workshop_machines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
  template TEXT NOT NULL CHECK(length(template) BETWEEN 1 AND 20000),
  created_at INTEGER NOT NULL
);
CREATE INDEX workshop_machines_owner ON workshop_machines(owner_id,created_at);
