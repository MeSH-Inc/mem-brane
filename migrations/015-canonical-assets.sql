-- Canonical hashes must be recoverable and agree across every frozen reference.
CREATE TEMP TABLE asset_hashes AS
SELECT json_extract(content_json,'$.assetId') id,json_extract(content_json,'$.assetHash') digest
FROM block_live_state WHERE json_extract(content_json,'$.assetId') IS NOT NULL
UNION ALL SELECT json_extract(content_json,'$.assetId'),json_extract(content_json,'$.assetHash')
FROM block_revisions WHERE json_extract(content_json,'$.assetId') IS NOT NULL;
CREATE TEMP TABLE asset_migration_check(ok INTEGER CHECK(ok=1));
INSERT INTO asset_migration_check SELECT CASE WHEN EXISTS(
 SELECT 1 FROM assets a LEFT JOIN asset_hashes h ON h.id=a.id GROUP BY a.id
 HAVING count(DISTINCT h.digest)!=1 OR min(length(h.digest))!=64
) THEN 0 ELSE 1 END;
ALTER TABLE assets ADD COLUMN digest TEXT;
UPDATE assets SET digest=(SELECT digest FROM asset_hashes WHERE id=assets.id LIMIT 1);
CREATE UNIQUE INDEX assets_owner_digest ON assets(owner_id,digest);
CREATE TRIGGER canonical_asset_insert BEFORE INSERT ON assets
WHEN NEW.digest IS NULL OR length(NEW.digest)!=64 OR NEW.digest GLOB '*[^0-9a-f]*' OR NEW.size<=0
BEGIN SELECT RAISE(ABORT,'invalid asset metadata'); END;
CREATE TRIGGER immutable_asset_update BEFORE UPDATE ON assets
BEGIN SELECT RAISE(ABORT,'immutable asset'); END;
ALTER TABLE upload_intents ADD COLUMN digest TEXT;
CREATE UNIQUE INDEX uploads_owner_digest ON upload_intents(owner_id,digest);
DROP TABLE asset_hashes;
DROP TABLE asset_migration_check;
