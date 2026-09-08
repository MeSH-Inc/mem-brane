CREATE TABLE extraction_policies(id TEXT PRIMARY KEY, policy_json TEXT NOT NULL CHECK(json_valid(policy_json)));
CREATE TABLE extraction_results(
 asset_id TEXT NOT NULL REFERENCES assets(id),
 policy_id TEXT NOT NULL REFERENCES extraction_policies(id),
 representation_id TEXT NOT NULL REFERENCES asset_representations(id),
 PRIMARY KEY(asset_id,policy_id)
);
CREATE TRIGGER immutable_extraction_policy BEFORE UPDATE ON extraction_policies BEGIN SELECT RAISE(ABORT,'immutable extraction policy'); END;
CREATE TRIGGER immutable_extraction_result BEFORE UPDATE ON extraction_results BEGIN SELECT RAISE(ABORT,'immutable extraction result'); END;
CREATE TRIGGER extraction_result_origin BEFORE INSERT ON extraction_results WHEN NOT EXISTS(
 SELECT 1 FROM asset_representations r WHERE r.id=NEW.representation_id AND r.asset_id=NEW.asset_id AND json_extract(r.payload_json,'$.extractionPolicy')=NEW.policy_id
) BEGIN SELECT RAISE(ABORT,'invalid extraction result'); END;
