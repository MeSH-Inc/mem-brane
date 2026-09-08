CREATE INDEX revisions_history ON block_revisions(block_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX runs_output_block ON runs(output_block_id);
CREATE INDEX placements_brane_block ON placements(brane_id, block_id);
