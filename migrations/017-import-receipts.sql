CREATE TABLE artifact_imports_new (
 owner_id TEXT NOT NULL REFERENCES "user"(id),
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
INSERT INTO artifact_imports_new SELECT owner_id,key,request_hash,asset_id,brane_id,state,
 json_extract(result_json,'$.id'),json_extract(result_json,'$.placement.id'),created_at FROM artifact_imports;
DROP TABLE artifact_imports;
ALTER TABLE artifact_imports_new RENAME TO artifact_imports;
CREATE INDEX imports_brane ON artifact_imports(brane_id);
CREATE TRIGGER immutable_import_receipt BEFORE UPDATE ON artifact_imports WHEN OLD.state='ready'
BEGIN SELECT RAISE(ABORT,'immutable import receipt'); END;
CREATE TRIGGER import_receipt_origin BEFORE UPDATE OF state ON artifact_imports WHEN NEW.state='ready' AND NOT EXISTS(
 SELECT 1 FROM blocks b JOIN placements p ON p.block_id=b.id
 JOIN block_live_state l ON l.block_id=b.id JOIN asset_representations r ON r.id=l.representation_id
 WHERE b.id=NEW.block_id AND b.owner_id=NEW.owner_id AND p.id=NEW.placement_id AND p.brane_id=NEW.brane_id AND r.asset_id=NEW.asset_id
) BEGIN SELECT RAISE(ABORT,'invalid import receipt'); END;
CREATE TEMP TABLE import_receipt_check(ok INTEGER CHECK(ok=1));
INSERT INTO import_receipt_check SELECT CASE WHEN EXISTS(
 SELECT 1 FROM artifact_imports i JOIN blocks b ON b.id=i.block_id JOIN branes br ON br.id=i.brane_id
 JOIN block_live_state l ON l.block_id=b.id JOIN asset_representations r ON r.id=l.representation_id
 LEFT JOIN placements p ON p.id=i.placement_id
 WHERE i.state='ready' AND (b.owner_id!=i.owner_id OR br.owner_id!=i.owner_id OR r.asset_id!=i.asset_id OR (p.id IS NOT NULL AND (p.block_id!=i.block_id OR p.brane_id!=i.brane_id)))
) THEN 0 ELSE 1 END;
DROP TABLE import_receipt_check;
