-- Content ownership survives changes to the principal that can access it.
CREATE TABLE libraries (
 id TEXT PRIMARY KEY,
 principal_id TEXT NOT NULL REFERENCES "user"(id),
 created_at INTEGER NOT NULL
);
CREATE INDEX libraries_principal ON libraries(principal_id,created_at);
INSERT INTO libraries SELECT id,id,createdAt FROM "user";
-- A user's initial private library uses their ID as its creation identity only.
-- Access always resolves principal_id; claiming never rewrites content ownership.
CREATE TRIGGER initial_library AFTER INSERT ON "user" BEGIN
 INSERT INTO libraries VALUES (NEW.id,NEW.id,NEW.createdAt);
END;
DROP TRIGGER "immutable_revision_delete";
DROP TRIGGER "immutable_output_update";
DROP TRIGGER "immutable_output_delete";
DROP TRIGGER "block_identity_update";
DROP TRIGGER "immutable_context_update";
DROP TRIGGER "immutable_context_delete";
DROP TRIGGER "immutable_context_entry_update";
DROP TRIGGER "immutable_context_entry_delete";
DROP TRIGGER "sealed_context_entry";
DROP TRIGGER "owned_context_parent";
DROP TRIGGER "owned_context_entry";
DROP TRIGGER "valid_run_context";
DROP TRIGGER "frozen_run_request";
DROP TRIGGER "immutable_message_update";
DROP TRIGGER "immutable_message_delete";
DROP TRIGGER "valid_message_origin";
DROP TRIGGER "canonical_asset_insert";
DROP TRIGGER "immutable_asset_update";
DROP TRIGGER "immutable_revision_update";
DROP TRIGGER "immutable_representation_update";
DROP TRIGGER "immutable_representation_delete";
DROP TRIGGER "valid_representation_insert";
DROP TRIGGER "block_live_state_representation_insert";
DROP TRIGGER "block_live_state_representation_update";
DROP TRIGGER "block_revisions_representation_insert";
DROP TRIGGER "immutable_import_receipt";
DROP TRIGGER "import_receipt_origin";
DROP TRIGGER "immutable_extraction_policy";
DROP TRIGGER "immutable_extraction_result";
DROP TRIGGER "extraction_result_origin";
DROP TRIGGER "summarize_representation";
DROP TRIGGER "summary_origin";
DROP TRIGGER "immutable_summary_update";
DROP TRIGGER "immutable_summary_delete";
DROP TRIGGER "immutable_consolidation_record";
DROP TRIGGER "consolidation_state_transition";
DROP TRIGGER "submission_receipts_immutable";
DROP TRIGGER "submission_receipts_no_delete";
DROP TRIGGER "immutable_cost_estimate";
DROP TRIGGER "immutable_spend_delete";
DROP TRIGGER "immutable_cost_reconciliation_update";
DROP TRIGGER "immutable_cost_reconciliation_delete";
DROP TRIGGER "immutable_ocr_grant_update";
DROP TRIGGER "immutable_ocr_grant_delete";
DROP TRIGGER "immutable_ocr_identity";
DROP TRIGGER "immutable_ocr_job_delete";
DROP TRIGGER "immutable_ocr_request_update";
DROP TRIGGER "immutable_ocr_request_delete";
DROP TRIGGER "immutable_ocr_result";
DROP TRIGGER "terminal_ocr_status";
CREATE TABLE "branes_library" (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES libraries(id), title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO "branes_library" SELECT * FROM "branes";
DROP TABLE "branes";
ALTER TABLE "branes_library" RENAME TO "branes";
CREATE TABLE "assets_library" (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES libraries(id), storage_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, digest TEXT);
INSERT INTO "assets_library" SELECT * FROM "assets";
DROP TABLE "assets";
ALTER TABLE "assets_library" RENAME TO "assets";
CREATE TABLE "conversations_library" (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES libraries(id), created_at INTEGER NOT NULL);
INSERT INTO "conversations_library" SELECT * FROM "conversations";
DROP TABLE "conversations";
ALTER TABLE "conversations_library" RENAME TO "conversations";
CREATE TABLE "upload_intents_library" (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  size INTEGER NOT NULL CHECK(size>=0),
  created_at INTEGER NOT NULL
, digest TEXT);
INSERT INTO "upload_intents_library" SELECT * FROM "upload_intents";
DROP TABLE "upload_intents";
ALTER TABLE "upload_intents_library" RENAME TO "upload_intents";
CREATE TABLE "blocks_library" (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  kind TEXT NOT NULL CHECK(kind IN ('text','image','webpage','pdf')),
  created_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'authored' CHECK(origin IN ('authored','generated'))
);
INSERT INTO "blocks_library" SELECT * FROM "blocks";
DROP TABLE "blocks";
ALTER TABLE "blocks_library" RENAME TO "blocks";
CREATE TABLE "context_manifests_library" (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  parent_message_id TEXT REFERENCES conversation_messages(id)
);
INSERT INTO "context_manifests_library" SELECT * FROM "context_manifests";
DROP TABLE "context_manifests";
ALTER TABLE "context_manifests_library" RENAME TO "context_manifests";
CREATE TABLE "runs_library" (
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
INSERT INTO "runs_library" SELECT * FROM "runs";
DROP TABLE "runs";
ALTER TABLE "runs_library" RENAME TO "runs";
CREATE TABLE "artifact_imports_library" (
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
INSERT INTO "artifact_imports_library" SELECT * FROM "artifact_imports";
DROP TABLE "artifact_imports";
ALTER TABLE "artifact_imports_library" RENAME TO "artifact_imports";
CREATE TABLE "spend_commitments_library" (
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
INSERT INTO "spend_commitments_library" SELECT * FROM "spend_commitments";
DROP TABLE "spend_commitments";
ALTER TABLE "spend_commitments_library" RENAME TO "spend_commitments";
CREATE TABLE "ocr_credit_grants_library" (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES libraries(id),
 kind TEXT NOT NULL CHECK(kind IN ('trial','prepaid')),
 pages INTEGER NOT NULL CHECK(pages>0),
 evidence TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
INSERT INTO "ocr_credit_grants_library" SELECT * FROM "ocr_credit_grants";
DROP TABLE "ocr_credit_grants";
ALTER TABLE "ocr_credit_grants_library" RENAME TO "ocr_credit_grants";
CREATE TABLE "ocr_jobs_library" (
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
INSERT INTO "ocr_jobs_library" SELECT * FROM "ocr_jobs";
DROP TABLE "ocr_jobs";
ALTER TABLE "ocr_jobs_library" RENAME TO "ocr_jobs";
CREATE TABLE "ocr_requests_library" (
 owner_id TEXT NOT NULL REFERENCES libraries(id),
 request_key TEXT NOT NULL,
 asset_digest TEXT NOT NULL,
 policy_id TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES ocr_jobs(id),
 PRIMARY KEY(owner_id,request_key)
);
INSERT INTO "ocr_requests_library" SELECT * FROM "ocr_requests";
DROP TABLE "ocr_requests";
ALTER TABLE "ocr_requests_library" RENAME TO "ocr_requests";
CREATE TABLE "workspace_operations_library" (
  owner_id TEXT NOT NULL REFERENCES libraries(id),
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, operation_key)
) WITHOUT ROWID;
INSERT INTO "workspace_operations_library" SELECT * FROM "workspace_operations";
DROP TABLE "workspace_operations";
ALTER TABLE "workspace_operations_library" RENAME TO "workspace_operations";
CREATE INDEX branes_owner ON branes(owner_id, updated_at);
CREATE INDEX upload_intents_owner ON upload_intents(owner_id);
CREATE INDEX runs_queue ON runs(status,created_at);
CREATE INDEX runs_brane ON runs(brane_id,created_at);
CREATE INDEX runs_owner ON runs(owner_id,status);
CREATE INDEX runs_finished ON runs(status,finished_at);
CREATE UNIQUE INDEX runs_output_block ON runs(output_block_id);
CREATE INDEX runs_brane_active ON runs(brane_id,created_at,id) WHERE status IN ('queued','claimed','running','cancel_requested');
CREATE INDEX runs_brane_history ON runs(brane_id,created_at DESC,id DESC);
CREATE INDEX runs_context ON runs(context_id);
CREATE UNIQUE INDEX assets_owner_digest ON assets(owner_id,digest);
CREATE UNIQUE INDEX uploads_owner_digest ON upload_intents(owner_id,digest);
CREATE INDEX imports_brane ON artifact_imports(brane_id);
CREATE INDEX spend_owner_day ON spend_commitments(owner_id,category,budget_day,status);
CREATE INDEX spend_category_day ON spend_commitments(category,budget_day,status);
CREATE UNIQUE INDEX one_ocr_trial ON ocr_credit_grants(owner_id) WHERE kind='trial';
CREATE INDEX ocr_queue ON ocr_jobs(status,created_at);
CREATE TRIGGER immutable_revision_delete BEFORE DELETE ON block_revisions BEGIN SELECT RAISE(ABORT, 'immutable revision'); END;
CREATE TRIGGER immutable_output_update BEFORE UPDATE ON run_outputs BEGIN SELECT RAISE(ABORT, 'immutable output'); END;
CREATE TRIGGER immutable_output_delete BEFORE DELETE ON run_outputs BEGIN SELECT RAISE(ABORT, 'immutable output'); END;
CREATE TRIGGER block_identity_update BEFORE UPDATE OF kind,origin ON blocks BEGIN SELECT RAISE(ABORT, 'Immutable artifact format and origin'); END;
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
CREATE TRIGGER canonical_asset_insert BEFORE INSERT ON assets
WHEN NEW.digest IS NULL OR length(NEW.digest)!=64 OR NEW.digest GLOB '*[^0-9a-f]*' OR NEW.size<=0
BEGIN SELECT RAISE(ABORT,'invalid asset metadata'); END;
CREATE TRIGGER immutable_asset_update BEFORE UPDATE ON assets
BEGIN SELECT RAISE(ABORT,'immutable asset'); END;
CREATE TRIGGER immutable_revision_update BEFORE UPDATE ON block_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
CREATE TRIGGER immutable_representation_update BEFORE UPDATE ON asset_representations BEGIN SELECT RAISE(ABORT,'immutable representation'); END;
CREATE TRIGGER immutable_representation_delete BEFORE DELETE ON asset_representations BEGIN SELECT RAISE(ABORT,'immutable representation'); END;
CREATE TRIGGER valid_representation_insert BEFORE INSERT ON asset_representations
WHEN NEW.id != representation_id(NEW.asset_id,NEW.format,NEW.payload_json) OR NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=NEW.asset_id AND
 ((NEW.format='pdf' AND a.mime='application/pdf' AND json_type(NEW.payload_json,'$.pageCount')='integer' AND json_extract(NEW.payload_json,'$.representation.kind')='pdf-text-v1') OR
 (NEW.format='image' AND a.mime IN ('image/png','image/jpeg','image/webp','image/gif') AND json_extract(NEW.payload_json,'$.representation')='original-image-v1')))
BEGIN SELECT RAISE(ABORT,'invalid representation'); END;
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
CREATE TRIGGER block_revisions_representation_insert BEFORE INSERT ON block_revisions
WHEN (json_extract(NEW.content_json,'$.format') IN ('image','pdf') AND (
 NEW.representation_id IS NULL OR NOT EXISTS(SELECT 1 FROM asset_representations r JOIN assets a ON a.id=r.asset_id JOIN blocks b ON b.id=NEW.block_id
 WHERE r.id=NEW.representation_id AND a.owner_id=b.owner_id AND r.format=b.kind AND r.format=json_extract(NEW.content_json,'$.format'))
 OR json_remove(NEW.content_json,'$.format','$.text','$.filename','$.representationId')!='{}'))
 OR (json_extract(NEW.content_json,'$.format') NOT IN ('image','pdf') AND NEW.representation_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'invalid content representation'); END;
CREATE TRIGGER immutable_import_receipt BEFORE UPDATE ON artifact_imports WHEN OLD.state='ready'
BEGIN SELECT RAISE(ABORT,'immutable import receipt'); END;
CREATE TRIGGER import_receipt_origin BEFORE UPDATE OF state ON artifact_imports WHEN NEW.state='ready' AND NOT EXISTS(
 SELECT 1 FROM blocks b JOIN placements p ON p.block_id=b.id
 JOIN block_live_state l ON l.block_id=b.id JOIN asset_representations r ON r.id=l.representation_id
 WHERE b.id=NEW.block_id AND b.owner_id=NEW.owner_id AND p.id=NEW.placement_id AND p.brane_id=NEW.brane_id AND r.asset_id=NEW.asset_id
) BEGIN SELECT RAISE(ABORT,'invalid import receipt'); END;
CREATE TRIGGER immutable_extraction_policy BEFORE UPDATE ON extraction_policies BEGIN SELECT RAISE(ABORT,'immutable extraction policy'); END;
CREATE TRIGGER immutable_extraction_result BEFORE UPDATE ON extraction_results BEGIN SELECT RAISE(ABORT,'immutable extraction result'); END;
CREATE TRIGGER extraction_result_origin BEFORE INSERT ON extraction_results WHEN NOT EXISTS(
 SELECT 1 FROM asset_representations r WHERE r.id=NEW.representation_id AND r.asset_id=NEW.asset_id AND json_extract(r.payload_json,'$.extractionPolicy')=NEW.policy_id
) BEGIN SELECT RAISE(ABORT,'invalid extraction result'); END;
CREATE TRIGGER summarize_representation AFTER INSERT ON asset_representations BEGIN
 INSERT INTO representation_summaries VALUES (NEW.id,json_remove(NEW.payload_json,'$.representation.pages'));
END;
CREATE TRIGGER summary_origin BEFORE INSERT ON representation_summaries WHEN NOT EXISTS(
 SELECT 1 FROM asset_representations r WHERE r.id=NEW.representation_id AND json_remove(r.payload_json,'$.representation.pages')=NEW.summary_json
) BEGIN SELECT RAISE(ABORT,'invalid representation summary'); END;
CREATE TRIGGER immutable_summary_update BEFORE UPDATE ON representation_summaries BEGIN SELECT RAISE(ABORT,'immutable representation summary'); END;
CREATE TRIGGER immutable_summary_delete BEFORE DELETE ON representation_summaries BEGIN SELECT RAISE(ABORT,'immutable representation summary'); END;
CREATE TRIGGER immutable_consolidation_record BEFORE UPDATE OF old_id,canonical_id,storage_key,digest,size,backup_fingerprint ON asset_consolidation_journal
BEGIN SELECT RAISE(ABORT,'immutable consolidation record'); END;
CREATE TRIGGER consolidation_state_transition BEFORE UPDATE OF state ON asset_consolidation_journal
WHEN NOT ((OLD.state='pending' AND NEW.state='deleting') OR (OLD.state='deleting' AND NEW.state IN ('deleting','deleted')))
BEGIN SELECT RAISE(ABORT,'invalid consolidation transition'); END;
CREATE TRIGGER submission_receipts_immutable BEFORE UPDATE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'Submission receipts are immutable'); END;
CREATE TRIGGER submission_receipts_no_delete BEFORE DELETE ON submission_receipts
BEGIN SELECT RAISE(ABORT, 'Submission receipts are immutable'); END;
CREATE TRIGGER immutable_cost_estimate BEFORE UPDATE OF id,category,run_id,owner_id,budget_day,reserved_microusd,estimated_units,pricing_json,created_at ON spend_commitments BEGIN SELECT RAISE(ABORT,'immutable cost estimate'); END;
CREATE TRIGGER immutable_spend_delete BEFORE DELETE ON spend_commitments BEGIN SELECT RAISE(ABORT,'immutable spend commitment'); END;
CREATE TRIGGER immutable_cost_reconciliation_update BEFORE UPDATE ON spend_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;
CREATE TRIGGER immutable_cost_reconciliation_delete BEFORE DELETE ON spend_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;
CREATE TRIGGER immutable_ocr_grant_update BEFORE UPDATE ON ocr_credit_grants BEGIN SELECT RAISE(ABORT,'immutable OCR credit grant'); END;
CREATE TRIGGER immutable_ocr_grant_delete BEFORE DELETE ON ocr_credit_grants BEGIN SELECT RAISE(ABORT,'immutable OCR credit grant'); END;
CREATE TRIGGER immutable_ocr_identity BEFORE UPDATE OF id,owner_id,asset_id,asset_digest,policy_id,policy_json,pages,created_at ON ocr_jobs BEGIN SELECT RAISE(ABORT,'immutable OCR job identity'); END;
CREATE TRIGGER immutable_ocr_job_delete BEFORE DELETE ON ocr_jobs BEGIN SELECT RAISE(ABORT,'immutable OCR job'); END;
CREATE TRIGGER immutable_ocr_request_update BEFORE UPDATE ON ocr_requests BEGIN SELECT RAISE(ABORT,'immutable OCR request'); END;
CREATE TRIGGER immutable_ocr_request_delete BEFORE DELETE ON ocr_requests BEGIN SELECT RAISE(ABORT,'immutable OCR request'); END;
CREATE TRIGGER immutable_ocr_result BEFORE UPDATE OF result_json ON ocr_jobs
WHEN OLD.result_json IS NOT NULL OR (NEW.result_json IS NOT NULL AND NEW.status!='succeeded')
BEGIN SELECT RAISE(ABORT,'immutable OCR result evidence'); END;
CREATE TRIGGER terminal_ocr_status BEFORE UPDATE OF status ON ocr_jobs
WHEN (OLD.status IN ('succeeded','cancelled','failed') AND NEW.status!=OLD.status)
 OR (OLD.status='uncertain' AND NEW.status NOT IN ('uncertain','failed'))
BEGIN SELECT RAISE(ABORT,'terminal OCR job cannot be replayed'); END;
