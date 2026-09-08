-- A delivery identity belongs to an actor and binds bytes plus destination intent.
CREATE TABLE artifact_imports (
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  brane_id TEXT NOT NULL REFERENCES branes(id),
  state TEXT NOT NULL CHECK(state IN ('pending','ready')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,key)
);
CREATE INDEX imports_brane ON artifact_imports(brane_id);

-- Tag stored content while preserving revision identities and exact asset hashes.
DROP TRIGGER immutable_revision_update;
UPDATE block_live_state SET content_json=json_set(content_json,'$.format',(SELECT kind FROM blocks WHERE id=block_id));
UPDATE block_revisions SET content_json=json_set(content_json,'$.format',(SELECT kind FROM blocks WHERE id=block_id));
UPDATE block_live_state SET content_json=json_set(content_json,'$.filename',json_extract(content_json,'$.text'),'$.representation','original-image-v1') WHERE json_extract(content_json,'$.format')='image';
UPDATE block_revisions SET content_json=json_set(content_json,'$.filename',json_extract(content_json,'$.text'),'$.representation','original-image-v1') WHERE json_extract(content_json,'$.format')='image';
CREATE TRIGGER immutable_revision_update BEFORE UPDATE ON block_revisions BEGIN SELECT RAISE(ABORT, 'immutable revision'); END;
