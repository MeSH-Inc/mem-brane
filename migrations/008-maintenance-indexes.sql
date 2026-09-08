CREATE INDEX session_expiry ON session(expiresAt);
CREATE INDEX verification_expiry ON verification(expiresAt);
CREATE INDEX runs_finished ON runs(status,finished_at);
