CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX mail_outbox_due ON mail_outbox(next_attempt_at);
CREATE TABLE backup_alert_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  failed_since INTEGER,
  last_alert_at INTEGER
);
INSERT INTO backup_alert_state(singleton) VALUES (1);
