-- Receipts are committed with the write and retained: arbitrarily late offline
-- retries must never become new writes. No duplicated artifact bodies here.
CREATE TABLE workspace_operations (
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, operation_key)
) WITHOUT ROWID;
