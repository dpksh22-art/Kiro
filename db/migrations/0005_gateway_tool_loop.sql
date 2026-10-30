ALTER TABLE tool_invocations ADD COLUMN attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL;
ALTER TABLE tool_invocations ADD COLUMN provider_call_id TEXT;
ALTER TABLE tool_invocations ADD COLUMN arguments_fingerprint TEXT;
ALTER TABLE tool_invocations ADD COLUMN updated_at TEXT;
ALTER TABLE tool_invocations ADD COLUMN result_truncated INTEGER NOT NULL DEFAULT 0 CHECK (result_truncated IN (0,1));

UPDATE tool_invocations SET updated_at = COALESCE(completed_at, started_at) WHERE updated_at IS NULL;

CREATE INDEX idx_tool_invocations_task_attempt ON tool_invocations(task_id, attempt_id, started_at);
CREATE UNIQUE INDEX idx_tool_invocations_attempt_call ON tool_invocations(attempt_id, provider_call_id)
  WHERE attempt_id IS NOT NULL AND provider_call_id IS NOT NULL;

-- Reconcile already-materialized built-ins from legacy declarative names to the fixed broker registry.
UPDATE agents SET allowed_tools_json = CASE slug
  WHEN 'research-analyst' THEN '["web_fetch"]'
  WHEN 'software-architect' THEN '["github_repository_read"]'
  WHEN 'frontend-developer' THEN '["github_repository_read"]'
  WHEN 'backend-developer' THEN '["github_repository_read"]'
  WHEN 'security-auditor' THEN '["github_repository_read","artifact_text_read"]'
  WHEN 'qa-engineer' THEN '["github_repository_read","artifact_text_read"]'
  WHEN 'github-maintainer' THEN '["github_repository_read"]'
  WHEN 'data-analyst' THEN '["artifact_text_read"]'
  WHEN 'documentation-writer' THEN '["github_repository_read","artifact_text_read"]'
  WHEN 'business-researcher' THEN '["web_fetch"]'
  WHEN 'code-reviewer' THEN '["github_repository_read","artifact_text_read"]'
  ELSE '[]'
END
WHERE is_template=1;
