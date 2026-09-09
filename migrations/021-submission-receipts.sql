CREATE TABLE submission_receipts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
CREATE TRIGGER submission_receipts_immutable BEFORE UPDATE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'Submission receipts are immutable'); END;
CREATE TRIGGER submission_receipts_no_delete BEFORE DELETE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'Submission receipts are immutable'); END;
