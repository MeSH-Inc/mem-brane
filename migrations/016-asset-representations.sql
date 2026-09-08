CREATE TABLE asset_representations (
 id TEXT PRIMARY KEY,
 asset_id TEXT NOT NULL REFERENCES assets(id),
 format TEXT NOT NULL CHECK(format IN ('image','pdf')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 UNIQUE(asset_id,format,payload_json)
);
CREATE TEMP TABLE legacy_representations AS
SELECT content_json,
 json_extract(content_json,'$.assetId') asset_id,
 json_extract(content_json,'$.format') format,
 canonical_json(json_remove(content_json,'$.format','$.text','$.filename','$.assetId','$.assetHash','$.mimeType')) payload_json
FROM block_live_state WHERE json_extract(content_json,'$.format') IN ('image','pdf')
UNION SELECT content_json,json_extract(content_json,'$.assetId'),json_extract(content_json,'$.format'),
 canonical_json(json_remove(content_json,'$.format','$.text','$.filename','$.assetId','$.assetHash','$.mimeType'))
FROM block_revisions WHERE json_extract(content_json,'$.format') IN ('image','pdf');
CREATE TEMP TABLE representation_migration_check(ok INTEGER CHECK(ok=1));
INSERT INTO representation_migration_check SELECT CASE WHEN EXISTS(
 SELECT 1 FROM legacy_representations l LEFT JOIN assets a ON a.id=l.asset_id
 WHERE a.id IS NULL OR a.digest IS NOT json_extract(l.content_json,'$.assetHash')
 OR a.mime IS NOT json_extract(l.content_json,'$.mimeType')
) THEN 0 ELSE 1 END;
INSERT INTO asset_representations SELECT representation_id(asset_id,format,payload_json),asset_id,format,payload_json
FROM legacy_representations GROUP BY asset_id,format,payload_json;
DROP TRIGGER immutable_revision_update;
UPDATE block_live_state SET content_json=json_object('format',json_extract(content_json,'$.format'),
 'text',json_extract(content_json,'$.text'),'filename',json_extract(content_json,'$.filename'),
 'representationId',(SELECT r.id FROM legacy_representations l JOIN asset_representations r
 ON r.asset_id=l.asset_id AND r.format=l.format AND r.payload_json=l.payload_json WHERE l.content_json=block_live_state.content_json))
WHERE json_extract(content_json,'$.format') IN ('image','pdf');
UPDATE block_revisions SET content_json=json_object('format',json_extract(content_json,'$.format'),
 'text',json_extract(content_json,'$.text'),'filename',json_extract(content_json,'$.filename'),
 'representationId',(SELECT r.id FROM legacy_representations l JOIN asset_representations r
 ON r.asset_id=l.asset_id AND r.format=l.format AND r.payload_json=l.payload_json WHERE l.content_json=block_revisions.content_json))
WHERE json_extract(content_json,'$.format') IN ('image','pdf');
CREATE TRIGGER immutable_revision_update BEFORE UPDATE ON block_revisions BEGIN SELECT RAISE(ABORT,'immutable revision'); END;
ALTER TABLE block_live_state ADD COLUMN representation_id TEXT GENERATED ALWAYS AS (json_extract(content_json,'$.representationId')) VIRTUAL REFERENCES asset_representations(id);
ALTER TABLE block_revisions ADD COLUMN representation_id TEXT GENERATED ALWAYS AS (json_extract(content_json,'$.representationId')) VIRTUAL REFERENCES asset_representations(id);
CREATE INDEX live_representation ON block_live_state(representation_id) WHERE representation_id IS NOT NULL;
CREATE INDEX revisions_representation ON block_revisions(representation_id) WHERE representation_id IS NOT NULL;
CREATE TRIGGER immutable_representation_update BEFORE UPDATE ON asset_representations BEGIN SELECT RAISE(ABORT,'immutable representation'); END;
CREATE TRIGGER immutable_representation_delete BEFORE DELETE ON asset_representations BEGIN SELECT RAISE(ABORT,'immutable representation'); END;
CREATE TRIGGER valid_representation_insert BEFORE INSERT ON asset_representations
WHEN NEW.id != representation_id(NEW.asset_id,NEW.format,NEW.payload_json) OR NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=NEW.asset_id AND
 ((NEW.format='pdf' AND a.mime='application/pdf' AND json_type(NEW.payload_json,'$.pageCount')='integer' AND json_extract(NEW.payload_json,'$.representation.kind')='pdf-text-v1') OR
 (NEW.format='image' AND a.mime IN ('image/png','image/jpeg','image/webp','image/gif') AND json_extract(NEW.payload_json,'$.representation')='original-image-v1')))
BEGIN SELECT RAISE(ABORT,'invalid representation'); END;
DROP TABLE legacy_representations;
DROP TABLE representation_migration_check;
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
CREATE TEMP TABLE representation_owner_check(ok INTEGER CHECK(ok=1));
INSERT INTO representation_owner_check SELECT CASE WHEN EXISTS(
 SELECT 1 FROM (SELECT block_id,representation_id FROM block_live_state UNION ALL SELECT block_id,representation_id FROM block_revisions) c
 JOIN asset_representations r ON r.id=c.representation_id JOIN assets a ON a.id=r.asset_id JOIN blocks b ON b.id=c.block_id
 WHERE a.owner_id!=b.owner_id OR r.format!=b.kind
) THEN 0 ELSE 1 END;
DROP TABLE representation_owner_check;
