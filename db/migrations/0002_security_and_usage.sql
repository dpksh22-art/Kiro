CREATE TRIGGER enforce_single_owner
BEFORE INSERT ON user
WHEN EXISTS (SELECT 1 FROM user LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'NEXUS personal deployment permits one owner account');
END;

ALTER TABLE usage_records ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE usage_records ADD COLUMN attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL;
CREATE INDEX idx_usage_task_status ON usage_records(task_id, status);
CREATE INDEX idx_usage_attempt_status ON usage_records(attempt_id, status);
