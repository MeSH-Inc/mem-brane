-- A small derived read model keeps PDF page bodies off workspace reads.
CREATE TABLE representation_summaries (
 representation_id TEXT PRIMARY KEY REFERENCES asset_representations(id),
 summary_json TEXT NOT NULL CHECK(json_valid(summary_json))
);
INSERT INTO representation_summaries SELECT id,json_remove(payload_json,'$.representation.pages') FROM asset_representations;
CREATE TRIGGER summarize_representation AFTER INSERT ON asset_representations BEGIN
 INSERT INTO representation_summaries VALUES (NEW.id,json_remove(NEW.payload_json,'$.representation.pages'));
END;
CREATE TRIGGER summary_origin BEFORE INSERT ON representation_summaries WHEN NOT EXISTS(
 SELECT 1 FROM asset_representations r WHERE r.id=NEW.representation_id AND json_remove(r.payload_json,'$.representation.pages')=NEW.summary_json
) BEGIN SELECT RAISE(ABORT,'invalid representation summary'); END;
CREATE TRIGGER immutable_summary_update BEFORE UPDATE ON representation_summaries BEGIN SELECT RAISE(ABORT,'immutable representation summary'); END;
CREATE TRIGGER immutable_summary_delete BEFORE DELETE ON representation_summaries BEGIN SELECT RAISE(ABORT,'immutable representation summary'); END;
