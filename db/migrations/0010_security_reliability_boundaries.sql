ALTER TABLE usage_records ADD COLUMN dispatched_at TEXT;
ALTER TABLE usage_records ADD COLUMN accounting_outcome TEXT NOT NULL DEFAULT 'reserved'
  CHECK (accounting_outcome IN ('reserved','completed','unknown','released'));
UPDATE usage_records SET accounting_outcome=CASE status WHEN 'settled' THEN 'completed' WHEN 'released' THEN 'released' ELSE 'reserved' END;
CREATE INDEX idx_usage_dispatch_recovery ON usage_records(status,dispatched_at,reservation_expires_at);

ALTER TABLE provider_connections ADD COLUMN validation_generation INTEGER NOT NULL DEFAULT 0 CHECK (validation_generation >= 0);

CREATE TABLE owner_runtime_state (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('active','quiescing')),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO owner_runtime_state(user_id,state,epoch,updated_at)
  SELECT id,'active',0,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM user;

CREATE TRIGGER owner_runtime_state_after_user_insert
AFTER INSERT ON user
BEGIN
  INSERT OR IGNORE INTO owner_runtime_state(user_id,state,epoch,updated_at)
  VALUES (NEW.id,'active',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
