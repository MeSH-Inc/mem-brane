CREATE TABLE upload_intents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  size INTEGER NOT NULL CHECK(size>=0),
  created_at INTEGER NOT NULL
);
CREATE INDEX upload_intents_owner ON upload_intents(owner_id);
CREATE INDEX ingestions_queue ON ingestions(status,created_at);
