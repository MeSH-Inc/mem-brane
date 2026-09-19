ALTER TABLE "user" ADD COLUMN isAnonymous INTEGER NOT NULL DEFAULT 0;
CREATE TABLE guest_policy (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 enabled INTEGER NOT NULL,
 lifetime_ms INTEGER NOT NULL,
 library_limit INTEGER NOT NULL,
 hourly_limit INTEGER NOT NULL
);
INSERT INTO guest_policy VALUES (1,1,2592000000,10000,100);
CREATE TABLE guest_libraries (
 library_id TEXT PRIMARY KEY REFERENCES libraries(id),
 expires_at INTEGER NOT NULL,
 claimed_by TEXT REFERENCES "user"(id),
 purged_at INTEGER
);
CREATE INDEX guest_expiry ON guest_libraries(claimed_by,expires_at);
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
UPDATE libraries SET created_at=CAST(unixepoch(created_at,'subsec')*1000 AS INTEGER) WHERE typeof(created_at)='text';
DROP TRIGGER initial_library;
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
CREATE UNIQUE INDEX one_guest_claim_intent ON guest_claim_intents(library_id);
-- Object deletion is acknowledged separately from deleting the SQL graph.
CREATE TABLE guest_object_deletions (
 storage_key TEXT PRIMARY KEY,
 library_id TEXT NOT NULL REFERENCES libraries(id),
 size INTEGER NOT NULL CHECK(size>=0)
);
