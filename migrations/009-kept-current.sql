-- Machines kept current. When a machine upstream of one reruns, it is due: the brane's
-- header offers to run every due machine, in feeding order. Nothing runs without a press.
CREATE TABLE kept_current (
  placement_id TEXT PRIMARY KEY REFERENCES placements(id) ON DELETE CASCADE
);
