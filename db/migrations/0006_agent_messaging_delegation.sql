ALTER TABLE agent_messages ADD COLUMN sender_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE agent_messages ADD COLUMN sender_attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL;
ALTER TABLE agent_messages ADD COLUMN recipient_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE agent_messages ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','acknowledged','expired'));
ALTER TABLE agent_messages ADD COLUMN trust_label TEXT NOT NULL DEFAULT 'untrusted_agent' CHECK (trust_label IN ('untrusted_agent','explicit_user'));
ALTER TABLE agent_messages ADD COLUMN idempotency_key TEXT;
ALTER TABLE agent_messages ADD COLUMN expires_at TEXT;
ALTER TABLE agent_messages ADD COLUMN delivered_at TEXT;
ALTER TABLE agent_messages ADD COLUMN acknowledged_at TEXT;
ALTER TABLE agent_messages ADD COLUMN updated_at TEXT;

UPDATE agent_messages
SET expires_at = datetime(created_at, '+1 hour'), updated_at = created_at
WHERE expires_at IS NULL;

CREATE INDEX idx_agent_messages_run_created ON agent_messages(run_id, created_at, id);
CREATE INDEX idx_agent_messages_recipient_pending ON agent_messages(run_id, recipient_agent_id, recipient_task_id, state, expires_at, created_at);
CREATE INDEX idx_agent_messages_correlation ON agent_messages(run_id, correlation_id, created_at);
CREATE UNIQUE INDEX idx_agent_messages_model_dedupe ON agent_messages(sender_task_id, idempotency_key)
  WHERE sender_task_id IS NOT NULL AND idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX idx_agent_messages_human_dedupe ON agent_messages(run_id, idempotency_key)
  WHERE sender_attempt_id IS NULL AND sender_agent_id IS NULL AND idempotency_key IS NOT NULL;

CREATE TABLE run_agent_participants (
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('initial','delegated')),
  introduced_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  instructions TEXT NOT NULL,
  allowed_tools_json TEXT NOT NULL,
  permission_policy_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  max_duration_seconds INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  output_schema_json TEXT,
  completion_criteria TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, agent_id)
);
CREATE INDEX idx_run_agent_participants_agent ON run_agent_participants(agent_id, run_id);

INSERT OR IGNORE INTO run_agent_participants
  (run_id, agent_id, source, instructions, allowed_tools_json, permission_policy_json, budget_json,
   max_duration_seconds, max_turns, output_schema_json, completion_criteria, created_at)
SELECT DISTINCT t.run_id, a.id, 'initial', a.instructions, a.allowed_tools_json, a.permission_policy_json,
  a.budget_json, a.max_duration_seconds, a.max_turns, a.output_schema_json, a.completion_criteria, t.created_at
FROM tasks t JOIN agents a ON a.id=t.assigned_agent_id;

CREATE TABLE task_delegations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  parent_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  recipient_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  message_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(parent_task_id, fingerprint),
  UNIQUE(parent_task_id, idempotency_key)
);
CREATE INDEX idx_task_delegations_run_parent ON task_delegations(run_id, parent_task_id, created_at);
