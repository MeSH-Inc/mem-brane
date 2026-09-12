CREATE TRIGGER immutable_ocr_result BEFORE UPDATE OF result_json ON ocr_jobs
WHEN OLD.result_json IS NOT NULL OR (NEW.result_json IS NOT NULL AND NEW.status!='succeeded')
BEGIN SELECT RAISE(ABORT,'immutable OCR result evidence'); END;

CREATE TRIGGER terminal_ocr_status BEFORE UPDATE OF status ON ocr_jobs
WHEN (OLD.status IN ('succeeded','cancelled','failed') AND NEW.status!=OLD.status)
 OR (OLD.status='uncertain' AND NEW.status NOT IN ('uncertain','failed'))
BEGIN SELECT RAISE(ABORT,'terminal OCR job cannot be replayed'); END;
