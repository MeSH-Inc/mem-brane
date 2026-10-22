-- Baseline schema. Each table is followed by its indexes and triggers.

CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, isAnonymous INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER initial_library AFTER INSERT ON "user" BEGIN
 SELECT CASE WHEN NEW.isAnonymous=1 AND (
   (SELECT enabled FROM guest_policy)=0 OR
   (SELECT COUNT(*) FROM guest_libraries WHERE claimed_by IS NULL AND purged_at IS NULL)>=(SELECT library_limit FROM guest_policy) OR
   (SELECT COUNT(*) FROM guest_admissions WHERE created_at>(CASE WHEN typeof(NEW.createdAt)='text' THEN CAST(unixepoch(NEW.createdAt,'subsec')*1000 AS INTEGER) ELSE NEW.createdAt END)-3600000)>=(SELECT hourly_limit FROM guest_policy)
 ) THEN RAISE(ABORT,'Guest entry capacity reached') END;
 INSERT INTO libraries VALUES (NEW.id,NEW.id,(CASE WHEN typeof(NEW.createdAt)='text' THEN CAST(unixepoch(NEW.createdAt,'subsec')*1000 AS INTEGER) ELSE NEW.createdAt END));
 INSERT INTO guest_libraries(library_id,expires_at)
   SELECT NEW.id,(CASE WHEN typeof(NEW.createdAt)='text' THEN CAST(unixepoch(NEW.createdAt,'subsec')*1000 AS INTEGER) ELSE NEW.createdAt END)+(SELECT lifetime_ms FROM guest_policy) WHERE NEW.isAnonymous=1;
 INSERT INTO guest_admissions SELECT NEW.id,(CASE WHEN typeof(NEW.createdAt)='text' THEN CAST(unixepoch(NEW.createdAt,'subsec')*1000 AS INTEGER) ELSE NEW.createdAt END) WHERE NEW.isAnonymous=1;
END;

CREATE TABLE session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE);
CREATE INDEX session_user ON session(userId);
CREATE INDEX session_expiry ON session(expiresAt);

CREATE TABLE account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE INDEX account_user ON account(userId);

CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER, updatedAt INTEGER);
CREATE INDEX verification_expiry ON verification(expiresAt);

CREATE TABLE block_live_state (block_id TEXT PRIMARY KEY REFERENCES blocks(id), content_json TEXT NOT NULL CHECK(json_valid(content_json)), version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, representation_id TEXT GENERATED ALWAYS AS (json_extract(content_json,'$.representationId')) VIRTUAL REFERENCES asset_representations(id));
CREATE INDEX live_representation ON block_live_state(representation_id) WHERE representation_id IS NOT NULL;
CREATE TRIGGER block_live_state_representation_insert BEFORE INSERT ON block_live_state
WHEN (json_extract(NEW.content_json,'$.format') IN ('image','pdf') AND (
 NEW.representation_id IS NULL OR NOT EXISTS(SELECT 1 FROM asset_representations r JOIN assets a ON a.id=r.asset_id JOIN blocks b ON b.id=NEW.block_id
 WHERE r.id=NEW.representation_id AND a.owner_id=b.owner_id AND r.format=b.kind AND r.format=json_extract(NEW.content_json,'$.format'))
 OR json_remove(NEW.content_json,'$.format','$.text','$.filename','$.representationId')!='{}'))
 OR (json_extract(NEW.content_json,'$.format') NOT IN ('image','pdf') AND NEW.representation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid content representation'); END;
CREATE TRIGGER block_live_state_representation_update BEFORE UPDATE ON block_live_state
WHEN (json_extract(NEW.content_json,'$.format') IN ('image','pdf') AND (
 NEW.representation_id IS NULL OR NOT EXISTS(SELECT 1 FROM asset_representations r JOIN assets a ON a.id=r.asset_id JOIN blocks b ON b.id=NEW.block_id
 WHERE r.id=NEW.representation_id AND a.owner_id=b.owner_id AND r.format=b.kind AND r.format=json_extract(NEW.content_json,'$.format'))
 OR json_remove(NEW.content_json,'$.format','$.text','$.filename','$.representationId')!='{}'))
 OR (json_extract(NEW.content_json,'$.format') NOT IN ('image','pdf') AND NEW.representation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid content representation'); END;

CREATE TABLE block_revisions (id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks(id), content_json TEXT NOT NULL CHECK(json_valid(content_json)), created_at INTEGER NOT NULL, source_version INTEGER CHECK(source_version >= 0), representation_id TEXT GENERATED ALWAYS AS (json_extract(content_json,'$.representationId')) VIRTUAL REFERENCES asset_representations(id));
CREATE INDEX revisions_block ON block_revisions(block_id, created_at);
CREATE UNIQUE INDEX revisions_source_version ON block_revisions(block_id, source_version)
WHERE source_version IS NOT NULL;
CREATE INDEX revisions_history ON block_revisions(block_id, created_at DESC, id DESC);
CREATE INDEX revisions_representation ON block_revisions(representation_id) WHERE representation_id IS NOT NULL;
CREATE TRIGGER immutable_revision_update BEFORE UPDATE ON block_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
CREATE TRIGGER block_revisions_representation_insert BEFORE INSERT ON block_revisions
WHEN (json_extract(NEW.content_json,'$.format') IN ('image','pdf') AND (
 NEW.representation_id IS NULL OR NOT EXISTS(SELECT 1 FROM asset_representations r JOIN assets a ON a.id=r.asset_id JOIN blocks b ON b.id=NEW.block_id
 WHERE r.id=NEW.representation_id AND a.owner_id=b.owner_id AND r.format=b.kind AND r.format=json_extract(NEW.content_json,'$.format'))
 OR json_remove(NEW.content_json,'$.format','$.text','$.filename','$.representationId')!='{}'))
 OR (json_extract(NEW.content_json,'$.format') NOT IN ('image','pdf') AND NEW.representation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid content representation'); END;
CREATE TRIGGER immutable_revision_delete BEFORE DELETE ON block_revisions
WHEN NOT EXISTS (
 SELECT 1 FROM blocks b JOIN guest_libraries g ON g.library_id=b.owner_id
 WHERE b.id=OLD.block_id AND g.purged_at IS NOT NULL AND g.claimed_by IS NULL
)
BEGIN SELECT RAISE(ABORT,'immutable revision'); END;

CREATE TABLE placements (id TEXT PRIMARY KEY, brane_id TEXT NOT NULL REFERENCES branes(id), block_id TEXT NOT NULL REFERENCES blocks(id), x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL CHECK(width>=180), height REAL NOT NULL CHECK(height>=120), z_index INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0));
CREATE INDEX placements_brane ON placements(brane_id);
CREATE INDEX placements_block ON placements(block_id);
CREATE INDEX placements_brane_block ON placements(brane_id, block_id);

CREATE TABLE run_outputs (run_id TEXT PRIMARY KEY REFERENCES runs(id), revision_id TEXT NOT NULL REFERENCES block_revisions(id), message_id TEXT NOT NULL REFERENCES conversation_messages(id));
CREATE TRIGGER immutable_output_update BEFORE UPDATE ON run_outputs BEGIN SELECT RAISE(ABORT, 'immutable output'); END;
CREATE TRIGGER immutable_output_delete BEFORE DELETE ON run_outputs BEGIN SELECT RAISE(ABORT, 'immutable output'); END;

CREATE TABLE run_checkpoints (run_id TEXT PRIMARY KEY REFERENCES runs(id), text TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE run_attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), worker_id TEXT NOT NULL, started_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT);

CREATE TABLE ingestions (block_id TEXT PRIMARY KEY REFERENCES blocks(id), status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX ingestions_queue ON ingestions(status,created_at);

CREATE TABLE run_placements (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  anchor_placement_id TEXT REFERENCES placements(id) ON DELETE SET NULL,
  output_placement_id TEXT REFERENCES placements(id) ON DELETE SET NULL
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
CREATE TRIGGER immutable_context_entry_update BEFORE UPDATE ON context_entries BEGIN SELECT RAISE(ABORT,'immutable context entry'); END;
CREATE TRIGGER immutable_context_entry_delete BEFORE DELETE ON context_entries BEGIN SELECT RAISE(ABORT,'immutable context entry'); END;
CREATE TRIGGER sealed_context_entry BEFORE INSERT ON context_entries
WHEN EXISTS (SELECT 1 FROM runs WHERE context_id=NEW.context_id)
BEGIN SELECT RAISE(ABORT,'sealed context'); END;
CREATE TRIGGER owned_context_entry BEFORE INSERT ON context_entries
WHEN NOT EXISTS (
  SELECT 1 FROM context_manifests c JOIN block_revisions v ON v.id=NEW.revision_id
  JOIN blocks b ON b.id=v.block_id WHERE c.id=NEW.context_id AND c.owner_id=b.owner_id
) BEGIN SELECT RAISE(ABORT,'invalid context revision'); END;

CREATE TABLE "conversation_messages" (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_id TEXT REFERENCES conversation_messages(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  revision_id TEXT NOT NULL REFERENCES block_revisions(id),
  created_at INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  UNIQUE(run_id,role)
);
CREATE INDEX messages_conversation ON conversation_messages(conversation_id);
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

CREATE TABLE asset_representations (
 id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL REFERENCES assets(id),
 format TEXT NOT NULL CHECK(format IN ('image','pdf')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(asset_id,format,payload_json)
);
CREATE TRIGGER immutable_representation_update BEFORE UPDATE ON asset_representations BEGIN SELECT RAISE(ABORT,'immutable representation'); END;
CREATE TRIGGER valid_representation_insert BEFORE INSERT ON asset_representations
WHEN NEW.id != representation_id(NEW.asset_id,NEW.format,NEW.payload_json) OR NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=NEW.asset_id AND
 ((NEW.format='pdf' AND a.mime='application/pdf' AND json_type(NEW.payload_json,'$.pageCount')='integer' AND json_extract(NEW.payload_json,'$.representation.kind')='pdf-text-v1') OR
 (NEW.format='image' AND a.mime IN ('image/png','image/jpeg','image/webp','image/gif') AND json_extract(NEW.payload_json,'$.representation')='original-image-v1')))
BEGIN SELECT RAISE(ABORT,'invalid representation'); END;
CREATE TRIGGER summarize_representation AFTER INSERT ON asset_representations BEGIN
 INSERT INTO representation_summaries VALUES (NEW.id,json_remove(NEW.payload_json,'$.representation.pages'));
END;
CREATE TRIGGER immutable_representation_delete BEFORE DELETE ON asset_representations
WHEN NOT EXISTS (
 SELECT 1 FROM assets a JOIN guest_libraries g ON g.library_id=a.owner_id
 WHERE a.id=OLD.asset_id AND g.purged_at IS NOT NULL AND g.claimed_by IS NULL
)
BEGIN SELECT RAISE(ABORT,'immutable representation'); END;

CREATE TABLE extraction_policies(id TEXT PRIMARY KEY, policy_json TEXT NOT NULL CHECK(json_valid(policy_json)));
CREATE TRIGGER immutable_extraction_policy BEFORE UPDATE ON extraction_policies BEGIN SELECT RAISE(ABORT,'immutable extraction policy'); END;

CREATE TABLE extraction_results(
 asset_id TEXT NOT NULL REFERENCES assets(id),
 policy_id TEXT NOT NULL REFERENCES extraction_policies(id),
 representation_id TEXT NOT NULL REFERENCES asset_representations(id),
 PRIMARY KEY(asset_id,policy_id)
);
CREATE TRIGGER immutable_extraction_result BEFORE UPDATE ON extraction_results BEGIN SELECT RAISE(ABORT,'immutable extraction result'); END;
CREATE TRIGGER extraction_result_origin BEFORE INSERT ON extraction_results WHEN NOT EXISTS(
 SELECT 1 FROM asset_representations r WHERE r.id=NEW.representation_id AND r.asset_id=NEW.asset_id AND json_extract(r.payload_json,'$.extractionPolicy')=NEW.policy_id
) BEGIN SELECT RAISE(ABORT,'invalid extraction result'); END;

CREATE TABLE representation_summaries (
 representation_id TEXT PRIMARY KEY REFERENCES asset_representations(id),
 summary_json TEXT NOT NULL CHECK(json_valid(summary_json))
);
CREATE TRIGGER summary_origin BEFORE INSERT ON representation_summaries WHEN NOT EXISTS(
 SELECT 1 FROM asset_representations r WHERE r.id=NEW.representation_id AND json_remove(r.payload_json,'$.representation.pages')=NEW.summary_json
) BEGIN SELECT RAISE(ABORT,'invalid representation summary'); END;
CREATE TRIGGER immutable_summary_update BEFORE UPDATE ON representation_summaries BEGIN SELECT RAISE(ABORT,'immutable representation summary'); END;
CREATE TRIGGER immutable_summary_delete BEFORE DELETE ON representation_summaries
WHEN NOT EXISTS (
 SELECT 1 FROM asset_representations r JOIN assets a ON a.id=r.asset_id
 JOIN guest_libraries g ON g.library_id=a.owner_id
 WHERE r.id=OLD.representation_id AND g.purged_at IS NOT NULL AND g.claimed_by IS NULL
)
BEGIN SELECT RAISE(ABORT,'immutable representation summary'); END;

CREATE TABLE submission_receipts (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
CREATE TRIGGER submission_receipts_immutable BEFORE UPDATE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'Submission receipts are immutable'); END;
CREATE TRIGGER submission_receipts_no_delete BEFORE DELETE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'Submission receipts are immutable'); END;

CREATE TABLE spend_reconciliations (
 commitment_id TEXT PRIMARY KEY REFERENCES spend_commitments(id),
 confirmed_microusd INTEGER NOT NULL CHECK(confirmed_microusd>=0),
 evidence TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TRIGGER immutable_cost_reconciliation_update BEFORE UPDATE ON spend_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;
CREATE TRIGGER immutable_cost_reconciliation_delete BEFORE DELETE ON spend_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;

CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mail_outbox_due ON mail_outbox(next_attempt_at);

CREATE TABLE backup_alert_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  failed_since INTEGER,
  last_alert_at INTEGER
);

CREATE TABLE libraries (
 id TEXT PRIMARY KEY,
 principal_id TEXT NOT NULL REFERENCES "user"(id),
 created_at INTEGER NOT NULL
);
CREATE INDEX libraries_principal ON libraries(principal_id,created_at);

CREATE TABLE "branes" (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES libraries(id), title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX branes_owner ON branes(owner_id, updated_at);

CREATE TABLE "assets" (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES libraries(id), storage_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, digest TEXT);
CREATE UNIQUE INDEX assets_owner_digest ON assets(owner_id,digest);
CREATE TRIGGER canonical_asset_insert BEFORE INSERT ON assets
WHEN NEW.digest IS NULL OR length(NEW.digest)!=64 OR NEW.digest GLOB '*[^0-9a-f]*' OR NEW.size<=0
BEGIN SELECT RAISE(ABORT,'invalid asset metadata'); END;
CREATE TRIGGER immutable_asset_update BEFORE UPDATE ON assets
BEGIN SELECT RAISE(ABORT,'immutable asset'); END;

CREATE TABLE "conversations" (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES libraries(id), created_at INTEGER NOT NULL);

CREATE TABLE "upload_intents" (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  size INTEGER NOT NULL CHECK(size>=0),
  created_at INTEGER NOT NULL
, digest TEXT);
CREATE INDEX upload_intents_owner ON upload_intents(owner_id);
CREATE UNIQUE INDEX uploads_owner_digest ON upload_intents(owner_id,digest);

CREATE TABLE "blocks" (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  kind TEXT NOT NULL CHECK(kind IN ('text','image','webpage','pdf')),
  created_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'authored' CHECK(origin IN ('authored','generated'))
);
CREATE INDEX blocks_library_history ON blocks(owner_id,created_at DESC,id DESC);
CREATE TRIGGER block_identity_update BEFORE UPDATE OF kind,origin ON blocks BEGIN SELECT RAISE(ABORT, 'Immutable artifact format and origin'); END;

CREATE TABLE "context_manifests" (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  parent_message_id TEXT REFERENCES conversation_messages(id)
);
CREATE TRIGGER immutable_context_update BEFORE UPDATE ON context_manifests BEGIN SELECT RAISE(ABORT,'immutable context'); END;
CREATE TRIGGER immutable_context_delete BEFORE DELETE ON context_manifests BEGIN SELECT RAISE(ABORT,'immutable context'); END;
CREATE TRIGGER owned_context_parent BEFORE INSERT ON context_manifests
WHEN NEW.parent_message_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id
  WHERE m.id=NEW.parent_message_id AND c.owner_id=NEW.owner_id
) BEGIN SELECT RAISE(ABORT,'invalid context parent'); END;

CREATE TABLE "runs" (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
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
CREATE INDEX runs_queue ON runs(status,created_at);
CREATE INDEX runs_brane ON runs(brane_id,created_at);
CREATE INDEX runs_owner ON runs(owner_id,status);
CREATE INDEX runs_finished ON runs(status,finished_at);
CREATE UNIQUE INDEX runs_output_block ON runs(output_block_id);
CREATE INDEX runs_brane_active ON runs(brane_id,created_at,id) WHERE status IN ('queued','claimed','running','cancel_requested');
CREATE INDEX runs_brane_history ON runs(brane_id,created_at DESC,id DESC);
CREATE INDEX runs_context ON runs(context_id);
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

CREATE TABLE "artifact_imports" (
 owner_id TEXT NOT NULL REFERENCES libraries(id),
 key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 asset_id TEXT NOT NULL,
 brane_id TEXT NOT NULL REFERENCES branes(id),
 state TEXT NOT NULL CHECK(state IN ('pending','ready')),
 block_id TEXT REFERENCES blocks(id),
 -- A historical creation identity survives removal of the mutable placement.
 placement_id TEXT,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_id,key),
 CHECK((state='pending' AND block_id IS NULL AND placement_id IS NULL) OR
       (state='ready' AND block_id IS NOT NULL AND placement_id IS NOT NULL))
);
CREATE INDEX imports_brane ON artifact_imports(brane_id);
CREATE TRIGGER immutable_import_receipt BEFORE UPDATE ON artifact_imports WHEN OLD.state='ready'
BEGIN SELECT RAISE(ABORT,'immutable import receipt'); END;
CREATE TRIGGER import_receipt_origin BEFORE UPDATE OF state ON artifact_imports WHEN NEW.state='ready' AND NOT EXISTS(
 SELECT 1 FROM blocks b JOIN placements p ON p.block_id=b.id
 JOIN block_live_state l ON l.block_id=b.id JOIN asset_representations r ON r.id=l.representation_id
 WHERE b.id=NEW.block_id AND b.owner_id=NEW.owner_id AND p.id=NEW.placement_id AND p.brane_id=NEW.brane_id AND r.asset_id=NEW.asset_id
) BEGIN SELECT RAISE(ABORT,'invalid import receipt'); END;

CREATE TABLE "spend_commitments" (
 id TEXT PRIMARY KEY,
 category TEXT NOT NULL CHECK(category IN ('model','ocr')),
 run_id TEXT UNIQUE REFERENCES runs(id),
 owner_id TEXT NOT NULL REFERENCES libraries(id),
 budget_day TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','confirmed','uncertain','released')),
 reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
 estimated_units INTEGER NOT NULL CHECK(estimated_units>=0),
 confirmed_microusd INTEGER,
 pricing_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK ((category='model' AND run_id IS NOT NULL AND run_id=id) OR (category='ocr' AND run_id IS NULL))
);
CREATE INDEX spend_owner_day ON spend_commitments(owner_id,category,budget_day,status);
CREATE INDEX spend_category_day ON spend_commitments(category,budget_day,status);
CREATE TRIGGER immutable_cost_estimate BEFORE UPDATE OF id,category,run_id,owner_id,budget_day,reserved_microusd,estimated_units,pricing_json,created_at ON spend_commitments BEGIN SELECT RAISE(ABORT,'immutable cost estimate'); END;
CREATE TRIGGER immutable_spend_delete BEFORE DELETE ON spend_commitments BEGIN SELECT RAISE(ABORT,'immutable spend commitment'); END;

CREATE TABLE "ocr_credit_grants" (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES libraries(id),
 kind TEXT NOT NULL CHECK(kind IN ('trial','prepaid')),
 pages INTEGER NOT NULL CHECK(pages>0),
 evidence TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_ocr_trial ON ocr_credit_grants(owner_id) WHERE kind='trial';
CREATE TRIGGER immutable_ocr_grant_update BEFORE UPDATE ON ocr_credit_grants BEGIN SELECT RAISE(ABORT,'immutable OCR credit grant'); END;
CREATE TRIGGER immutable_ocr_grant_delete BEFORE DELETE ON ocr_credit_grants BEGIN SELECT RAISE(ABORT,'immutable OCR credit grant'); END;

CREATE TABLE "ocr_jobs" (
 id TEXT PRIMARY KEY REFERENCES spend_commitments(id),
 owner_id TEXT NOT NULL REFERENCES libraries(id),
 asset_id TEXT NOT NULL REFERENCES assets(id),
 asset_digest TEXT NOT NULL,
 policy_id TEXT NOT NULL,
 policy_json TEXT NOT NULL,
 pages INTEGER NOT NULL CHECK(pages BETWEEN 1 AND 100),
 credit_pages INTEGER NOT NULL CHECK(credit_pages>=0 AND credit_pages<=pages),
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','uncertain','cancelled','failed')),
 attempt_id TEXT,
 deadline INTEGER,
 result_json TEXT,
 error TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(owner_id,asset_digest,policy_id)
);
CREATE INDEX ocr_queue ON ocr_jobs(status,created_at);
CREATE TRIGGER immutable_ocr_identity BEFORE UPDATE OF id,owner_id,asset_id,asset_digest,policy_id,policy_json,pages,created_at ON ocr_jobs BEGIN SELECT RAISE(ABORT,'immutable OCR job identity'); END;
CREATE TRIGGER immutable_ocr_job_delete BEFORE DELETE ON ocr_jobs BEGIN SELECT RAISE(ABORT,'immutable OCR job'); END;
CREATE TRIGGER immutable_ocr_result BEFORE UPDATE OF result_json ON ocr_jobs
WHEN OLD.result_json IS NOT NULL OR (NEW.result_json IS NOT NULL AND NEW.status!='succeeded')
BEGIN SELECT RAISE(ABORT,'immutable OCR result evidence'); END;
CREATE TRIGGER terminal_ocr_status BEFORE UPDATE OF status ON ocr_jobs
WHEN (OLD.status IN ('succeeded','cancelled','failed') AND NEW.status!=OLD.status)
 OR (OLD.status='uncertain' AND NEW.status NOT IN ('uncertain','failed'))
BEGIN SELECT RAISE(ABORT,'terminal OCR job cannot be replayed'); END;

CREATE TABLE "ocr_requests" (
 owner_id TEXT NOT NULL REFERENCES libraries(id),
 request_key TEXT NOT NULL,
 asset_digest TEXT NOT NULL,
 policy_id TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES ocr_jobs(id),
 PRIMARY KEY(owner_id,request_key)
);
CREATE TRIGGER immutable_ocr_request_update BEFORE UPDATE ON ocr_requests BEGIN SELECT RAISE(ABORT,'immutable OCR request'); END;
CREATE TRIGGER immutable_ocr_request_delete BEFORE DELETE ON ocr_requests BEGIN SELECT RAISE(ABORT,'immutable OCR request'); END;

CREATE TABLE "workspace_operations" (
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, operation_key)
) WITHOUT ROWID;

CREATE TABLE guest_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 enabled INTEGER NOT NULL,
 lifetime_ms INTEGER NOT NULL,
 library_limit INTEGER NOT NULL,
 hourly_limit INTEGER NOT NULL
);

CREATE TABLE guest_libraries (
 library_id TEXT PRIMARY KEY REFERENCES libraries(id),
 expires_at INTEGER NOT NULL,
 claimed_by TEXT REFERENCES "user"(id),
 purged_at INTEGER
);
CREATE INDEX guest_expiry ON guest_libraries(claimed_by,expires_at);
CREATE INDEX guest_reclamation ON guest_libraries(expires_at,library_id)
WHERE claimed_by IS NULL AND purged_at IS NULL;
CREATE TRIGGER guest_purge_terminal BEFORE UPDATE ON guest_libraries
WHEN OLD.purged_at IS NOT NULL OR (NEW.purged_at IS NOT NULL AND NEW.claimed_by IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Purged guest libraries cannot be changed or claimed'); END;

CREATE TABLE guest_admissions (principal_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE INDEX guest_admission_time ON guest_admissions(created_at);

CREATE TABLE library_claims (
 library_id TEXT PRIMARY KEY REFERENCES libraries(id),
 guest_principal_id TEXT NOT NULL REFERENCES "user"(id),
 principal_id TEXT NOT NULL REFERENCES "user"(id),
 created_at INTEGER NOT NULL
);
CREATE TRIGGER immutable_library_claim_update BEFORE UPDATE ON library_claims
BEGIN SELECT RAISE(ABORT,'immutable library claim'); END;
CREATE TRIGGER immutable_library_claim_delete BEFORE DELETE ON library_claims
BEGIN SELECT RAISE(ABORT,'immutable library claim'); END;

CREATE TABLE guest_claim_intents (
 token_hash TEXT PRIMARY KEY,
 library_id TEXT NOT NULL REFERENCES libraries(id),
 guest_principal_id TEXT NOT NULL REFERENCES "user"(id),
 expires_at INTEGER NOT NULL
);
CREATE INDEX guest_claim_expiry ON guest_claim_intents(expires_at);
CREATE UNIQUE INDEX one_guest_claim_intent ON guest_claim_intents(library_id);

CREATE TABLE guest_object_deletions (
 storage_key TEXT PRIMARY KEY,
 library_id TEXT NOT NULL REFERENCES libraries(id),
 size INTEGER NOT NULL CHECK(size>=0)
, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX guest_deletion_retry ON guest_object_deletions(next_attempt_at,storage_key);

-- Singleton rows.
INSERT INTO backup_alert_state (singleton, failed_since, last_alert_at) VALUES (1, NULL, NULL);
INSERT INTO guest_policy (singleton, enabled, lifetime_ms, library_limit, hourly_limit) VALUES (1, 1, 2592000000, 10000, 100);
