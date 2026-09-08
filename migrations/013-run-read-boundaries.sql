CREATE INDEX runs_brane_active ON runs(brane_id,created_at,id)
WHERE status IN ('queued','claimed','running','cancel_requested');
CREATE INDEX runs_brane_history ON runs(brane_id,created_at DESC,id DESC);
