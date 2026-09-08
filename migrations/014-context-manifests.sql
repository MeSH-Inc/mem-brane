-- A request stores its parent conversation point and only its own ordered inputs.
-- Retries may share the same sealed manifest. Historical identities stay intact.
CREATE TABLE context_manifests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  parent_message_id TEXT REFERENCES conversation_messages(id)
);
CREATE TABLE context_entries (
  context_id TEXT NOT NULL REFERENCES context_manifests(id),
  position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0),
  kind TEXT NOT NULL CHECK(kind IN ('source','reference','prompt')),
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role='user'),
  revision_id TEXT NOT NULL REFERENCES block_revisions(id),
  PRIMARY KEY(context_id,position)
);
CREATE INDEX context_entries_revision ON context_entries(revision_id);
INSERT INTO context_manifests SELECT id,owner_id,continue_from FROM runs;
INSERT INTO context_entries
SELECT run_id,row_number() OVER (PARTITION BY run_id ORDER BY position)-1,kind,label,role,revision_id
FROM run_inputs WHERE kind IN ('source','reference','prompt');

CREATE TABLE conversation_messages_next (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_id TEXT REFERENCES conversation_messages(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  revision_id TEXT NOT NULL REFERENCES block_revisions(id),
  created_at INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  UNIQUE(run_id,role)
);
INSERT INTO conversation_messages_next
SELECT m.id,m.conversation_id,m.parent_id,m.role,m.revision_id,m.created_at,
  CASE WHEN m.role='assistant' THEN (SELECT run_id FROM run_outputs WHERE message_id=m.id)
  ELSE (SELECT o.run_id FROM run_outputs o JOIN conversation_messages a ON a.id=o.message_id WHERE a.parent_id=m.id) END
FROM conversation_messages m;

-- Refuse a migration that would change any frozen input sequence, including
-- labels, repeated references, branch boundaries or continuation from a user turn.
CREATE TEMP TABLE context_migration_check (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO context_migration_check
SELECT NOT EXISTS (
  SELECT 1 FROM conversation_messages m JOIN conversation_messages_next n ON n.id=m.id
  WHERE m.role='user' AND json(m.context_json)<>(
    SELECT json_group_array(json_object('revisionId',revision_id,'label',label))
    FROM (SELECT revision_id,label FROM context_entries WHERE context_id=n.run_id AND kind IN ('source','reference') ORDER BY position)
  )
);
CREATE TEMP TABLE expanded_legacy_inputs AS
WITH RECURSIVE ancestors(run_id,message_id,depth) AS (
  SELECT id,continue_from,0 FROM runs WHERE continue_from IS NOT NULL
  UNION ALL
  SELECT a.run_id,m.parent_id,a.depth+1 FROM ancestors a
  JOIN conversation_messages m ON m.id=a.message_id
  WHERE m.parent_id IS NOT NULL AND a.depth<200
), entries AS (
  SELECT a.run_id,a.depth,0 part,e.position seq,'lineage_reference' kind,e.label,'user' role,e.revision_id
  FROM ancestors a JOIN conversation_messages_next m ON m.id=a.message_id
  JOIN context_entries e ON e.context_id=m.run_id
  WHERE m.role='user' AND e.kind IN ('source','reference')
  UNION ALL
  SELECT a.run_id,a.depth,1,0,'lineage','Conversation',m.role,m.revision_id
  FROM ancestors a JOIN conversation_messages_next m ON m.id=a.message_id
  UNION ALL
  SELECT context_id,-1,0,position,kind,label,role,revision_id FROM context_entries
)
SELECT run_id,row_number() OVER (PARTITION BY run_id ORDER BY depth DESC,part,seq)-1 position,kind,label,role,revision_id FROM entries;
INSERT INTO context_migration_check
SELECT NOT EXISTS (SELECT * FROM expanded_legacy_inputs EXCEPT SELECT * FROM run_inputs)
AND NOT EXISTS (SELECT * FROM run_inputs EXCEPT SELECT * FROM expanded_legacy_inputs);
DROP TABLE expanded_legacy_inputs;
DROP TABLE context_migration_check;

CREATE TABLE runs_next (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  brane_id TEXT NOT NULL REFERENCES branes(id),
  submission_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','claimed','running','completed','failed','cancel_requested','cancelled','interrupted')),
  provider TEXT NOT NULL, model TEXT NOT NULL, options_json TEXT NOT NULL,
  output_block_id TEXT NOT NULL REFERENCES blocks(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  context_id TEXT NOT NULL REFERENCES context_manifests(id),
  retry_of TEXT REFERENCES runs(id),
  lease_owner TEXT, lease_until INTEGER, usage_json TEXT, estimated_usage_json TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
  UNIQUE(owner_id,submission_key)
);
INSERT INTO runs_next SELECT id,owner_id,brane_id,submission_key,request_hash,status,provider,model,options_json,output_block_id,conversation_id,id,retry_of,lease_owner,lease_until,usage_json,estimated_usage_json,error,created_at,started_at,finished_at FROM runs;
DROP TABLE run_inputs;
DROP TABLE conversation_messages;
ALTER TABLE conversation_messages_next RENAME TO conversation_messages;
DROP TABLE runs;
ALTER TABLE runs_next RENAME TO runs;

CREATE INDEX messages_conversation ON conversation_messages(conversation_id);
CREATE INDEX runs_queue ON runs(status,created_at);
CREATE INDEX runs_brane ON runs(brane_id,created_at);
CREATE INDEX runs_owner ON runs(owner_id,status);
CREATE INDEX runs_finished ON runs(status,finished_at);
CREATE UNIQUE INDEX runs_output_block ON runs(output_block_id);
CREATE INDEX runs_brane_active ON runs(brane_id,created_at,id) WHERE status IN ('queued','claimed','running','cancel_requested');
CREATE INDEX runs_brane_history ON runs(brane_id,created_at DESC,id DESC);
CREATE INDEX runs_context ON runs(context_id);

CREATE TRIGGER immutable_context_update BEFORE UPDATE ON context_manifests BEGIN SELECT RAISE(ABORT,'immutable context'); END;
CREATE TRIGGER immutable_context_delete BEFORE DELETE ON context_manifests BEGIN SELECT RAISE(ABORT,'immutable context'); END;
CREATE TRIGGER immutable_context_entry_update BEFORE UPDATE ON context_entries BEGIN SELECT RAISE(ABORT,'immutable context entry'); END;
CREATE TRIGGER immutable_context_entry_delete BEFORE DELETE ON context_entries BEGIN SELECT RAISE(ABORT,'immutable context entry'); END;
CREATE TRIGGER sealed_context_entry BEFORE INSERT ON context_entries
WHEN EXISTS (SELECT 1 FROM runs WHERE context_id=NEW.context_id)
BEGIN SELECT RAISE(ABORT,'sealed context'); END;
CREATE TRIGGER owned_context_parent BEFORE INSERT ON context_manifests
WHEN NEW.parent_message_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
  WHERE m.id=NEW.parent_message_id AND c.owner_id=NEW.owner_id
) BEGIN SELECT RAISE(ABORT,'invalid context parent'); END;
CREATE TRIGGER owned_context_entry BEFORE INSERT ON context_entries
WHEN NOT EXISTS (
  SELECT 1 FROM context_manifests c JOIN block_revisions v ON v.id=NEW.revision_id
  JOIN blocks b ON b.id=v.block_id WHERE c.id=NEW.context_id AND c.owner_id=b.owner_id
) BEGIN SELECT RAISE(ABORT,'invalid context revision'); END;
CREATE TRIGGER valid_run_context BEFORE INSERT ON runs
WHEN NOT EXISTS (
  SELECT 1 FROM context_manifests c JOIN conversations conversation ON conversation.id=NEW.conversation_id
  WHERE c.id=NEW.context_id AND c.owner_id=NEW.owner_id AND conversation.owner_id=NEW.owner_id
  AND (c.parent_message_id IS NULL OR EXISTS (SELECT 1 FROM conversation_messages m WHERE m.id=c.parent_message_id AND m.conversation_id=NEW.conversation_id))
) OR (SELECT count(*) FROM context_entries WHERE context_id=NEW.context_id AND kind='prompt')<>1
OR (SELECT kind FROM context_entries WHERE context_id=NEW.context_id ORDER BY position DESC LIMIT 1)<>'prompt'
OR (SELECT count(*) FROM context_entries WHERE context_id=NEW.context_id)<>(SELECT max(position)+1 FROM context_entries WHERE context_id=NEW.context_id)
BEGIN SELECT RAISE(ABORT,'invalid run context'); END;
CREATE TRIGGER frozen_run_request BEFORE UPDATE OF owner_id,brane_id,submission_key,request_hash,provider,model,options_json,output_block_id,conversation_id,context_id,retry_of ON runs BEGIN SELECT RAISE(ABORT,'immutable run request'); END;
CREATE TRIGGER immutable_message_update BEFORE UPDATE ON conversation_messages BEGIN SELECT RAISE(ABORT,'immutable message'); END;
CREATE TRIGGER immutable_message_delete BEFORE DELETE ON conversation_messages BEGIN SELECT RAISE(ABORT,'immutable message'); END;
CREATE TRIGGER valid_message_origin BEFORE INSERT ON conversation_messages
WHEN NOT EXISTS (
  SELECT 1 FROM runs r JOIN context_manifests c ON c.id=r.context_id
  WHERE r.id=NEW.run_id AND r.conversation_id=NEW.conversation_id
  AND ((NEW.role='user' AND NEW.parent_id IS c.parent_message_id AND EXISTS (
    SELECT 1 FROM context_entries e WHERE e.context_id=c.id AND e.kind='prompt' AND e.revision_id=NEW.revision_id
  )) OR (NEW.role='assistant' AND EXISTS (
    SELECT 1 FROM conversation_messages parent JOIN block_revisions v ON v.id=NEW.revision_id
    WHERE parent.id=NEW.parent_id AND parent.run_id=r.id AND parent.role='user' AND v.block_id=r.output_block_id
  )))
) BEGIN SELECT RAISE(ABORT,'invalid message origin'); END;
