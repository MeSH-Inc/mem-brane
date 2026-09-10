CREATE TABLE spend_commitments (
 id TEXT PRIMARY KEY,
 category TEXT NOT NULL CHECK(category IN ('model','ocr')),
 run_id TEXT UNIQUE REFERENCES runs(id),
 owner_id TEXT NOT NULL REFERENCES "user"(id),
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
INSERT INTO spend_commitments SELECT run_id,'model',run_id,owner_id,budget_day,status,reserved_microusd,estimated_input_tokens,confirmed_microusd,pricing_json,created_at,updated_at FROM run_costs;
CREATE INDEX spend_owner_day ON spend_commitments(owner_id,category,budget_day,status);
CREATE INDEX spend_category_day ON spend_commitments(category,budget_day,status);
CREATE TABLE spend_reconciliations (
 commitment_id TEXT PRIMARY KEY REFERENCES spend_commitments(id),
 confirmed_microusd INTEGER NOT NULL CHECK(confirmed_microusd>=0),
 evidence TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
INSERT INTO spend_reconciliations SELECT * FROM run_cost_reconciliations;
DROP TABLE run_cost_reconciliations;
DROP TABLE run_costs;
CREATE TRIGGER immutable_cost_estimate BEFORE UPDATE OF id,category,run_id,owner_id,budget_day,reserved_microusd,estimated_units,pricing_json,created_at ON spend_commitments BEGIN SELECT RAISE(ABORT,'immutable cost estimate'); END;
CREATE TRIGGER immutable_spend_delete BEFORE DELETE ON spend_commitments BEGIN SELECT RAISE(ABORT,'immutable spend commitment'); END;
CREATE TRIGGER immutable_cost_reconciliation_update BEFORE UPDATE ON spend_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;
CREATE TRIGGER immutable_cost_reconciliation_delete BEFORE DELETE ON spend_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;
