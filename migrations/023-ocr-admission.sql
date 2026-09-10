CREATE TABLE ocr_credit_grants (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES "user"(id),
 kind TEXT NOT NULL CHECK(kind IN ('trial','prepaid')),
 pages INTEGER NOT NULL CHECK(pages>0),
 evidence TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_ocr_trial ON ocr_credit_grants(owner_id) WHERE kind='trial';
CREATE TRIGGER immutable_ocr_grant_update BEFORE UPDATE ON ocr_credit_grants BEGIN SELECT RAISE(ABORT,'immutable OCR credit grant'); END;
CREATE TRIGGER immutable_ocr_grant_delete BEFORE DELETE ON ocr_credit_grants BEGIN SELECT RAISE(ABORT,'immutable OCR credit grant'); END;
CREATE TABLE ocr_jobs (
 id TEXT PRIMARY KEY REFERENCES spend_commitments(id),
 owner_id TEXT NOT NULL REFERENCES "user"(id),
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
CREATE TABLE ocr_requests (
 owner_id TEXT NOT NULL REFERENCES "user"(id),
 request_key TEXT NOT NULL,
 asset_digest TEXT NOT NULL,
 policy_id TEXT NOT NULL,
 job_id TEXT NOT NULL REFERENCES ocr_jobs(id),
 PRIMARY KEY(owner_id,request_key)
);
CREATE TRIGGER immutable_ocr_identity BEFORE UPDATE OF id,owner_id,asset_id,asset_digest,policy_id,policy_json,pages,created_at ON ocr_jobs BEGIN SELECT RAISE(ABORT,'immutable OCR job identity'); END;
CREATE TRIGGER immutable_ocr_job_delete BEFORE DELETE ON ocr_jobs BEGIN SELECT RAISE(ABORT,'immutable OCR job'); END;
CREATE TRIGGER immutable_ocr_request_update BEFORE UPDATE ON ocr_requests BEGIN SELECT RAISE(ABORT,'immutable OCR request'); END;
CREATE TRIGGER immutable_ocr_request_delete BEFORE DELETE ON ocr_requests BEGIN SELECT RAISE(ABORT,'immutable OCR request'); END;
