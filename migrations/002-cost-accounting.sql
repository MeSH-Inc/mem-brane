CREATE TABLE run_costs (
 run_id TEXT PRIMARY KEY REFERENCES runs(id),
 owner_id TEXT NOT NULL REFERENCES "user"(id),
 budget_day TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','confirmed','uncertain','released')),
 reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
 estimated_input_tokens INTEGER NOT NULL,
 confirmed_microusd INTEGER,
 pricing_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX costs_owner_day ON run_costs(owner_id,budget_day,status);
