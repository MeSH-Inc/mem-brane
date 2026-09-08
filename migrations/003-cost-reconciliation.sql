CREATE TABLE run_cost_reconciliations(run_id TEXT PRIMARY KEY REFERENCES run_costs(run_id),confirmed_microusd INTEGER NOT NULL CHECK(confirmed_microusd>=0),evidence TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TRIGGER immutable_cost_reconciliation_update BEFORE UPDATE ON run_cost_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;
CREATE TRIGGER immutable_cost_reconciliation_delete BEFORE DELETE ON run_cost_reconciliations BEGIN SELECT RAISE(ABORT,'immutable cost reconciliation'); END;
