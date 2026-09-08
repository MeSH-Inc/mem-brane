-- Format and origin are independent. Existing generated content remains immutable.
ALTER TABLE blocks ADD COLUMN origin TEXT NOT NULL DEFAULT 'authored' CHECK(origin IN ('authored','generated'));
UPDATE blocks SET origin='generated', kind='text' WHERE kind='response';
CREATE TRIGGER block_format_insert BEFORE INSERT ON blocks WHEN NEW.kind='response' BEGIN SELECT RAISE(ABORT, 'Use content format and origin'); END;
CREATE TRIGGER block_identity_update BEFORE UPDATE OF kind,origin ON blocks BEGIN SELECT RAISE(ABORT, 'Immutable artifact format and origin'); END;

DROP TRIGGER immutable_input_update;
DROP TRIGGER immutable_input_delete;
ALTER TABLE run_inputs RENAME TO old_run_inputs;
CREATE TABLE run_inputs (run_id TEXT NOT NULL REFERENCES runs(id), position INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('source','reference','lineage_reference','lineage','prompt')), label TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), revision_id TEXT NOT NULL REFERENCES block_revisions(id), PRIMARY KEY(run_id,position));
INSERT INTO run_inputs SELECT * FROM old_run_inputs;
DROP TABLE old_run_inputs;
CREATE TRIGGER immutable_input_update BEFORE UPDATE ON run_inputs BEGIN SELECT RAISE(ABORT, 'immutable run input'); END;
CREATE TRIGGER immutable_input_delete BEFORE DELETE ON run_inputs BEGIN SELECT RAISE(ABORT, 'immutable run input'); END;
CREATE INDEX inputs_revision ON run_inputs(revision_id);

-- Presentation anchors are disposable; provenance lives in run_inputs/run_outputs.
CREATE TABLE run_placements (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  anchor_placement_id TEXT REFERENCES placements(id) ON DELETE SET NULL,
  output_placement_id TEXT REFERENCES placements(id) ON DELETE SET NULL
);
