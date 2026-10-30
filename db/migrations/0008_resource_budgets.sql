ALTER TABLE usage_records ADD COLUMN reservation_expires_at TEXT;

UPDATE usage_records
SET reservation_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+1 day')
WHERE status = 'reserved' AND reservation_expires_at IS NULL;

CREATE TABLE resource_budget_policies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  unit TEXT NOT NULL CHECK (unit IN ('model_calls','input_tokens','output_tokens','tool_calls','task_starts')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('owner','project','provider','run','agent')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT,
  run_id TEXT REFERENCES task_runs(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('task','run','daily','monthly')),
  hard_limit INTEGER NOT NULL CHECK (hard_limit >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope_type = 'owner' AND project_id IS NULL AND provider IS NULL AND run_id IS NULL AND agent_id IS NULL) OR
    (scope_type = 'project' AND project_id IS NOT NULL AND provider IS NULL AND run_id IS NULL AND agent_id IS NULL) OR
    (scope_type = 'provider' AND project_id IS NULL AND provider IS NOT NULL AND run_id IS NULL AND agent_id IS NULL) OR
    (scope_type = 'run' AND project_id IS NULL AND provider IS NULL AND run_id IS NOT NULL AND agent_id IS NULL) OR
    (scope_type = 'agent' AND project_id IS NULL AND provider IS NULL AND run_id IS NULL AND agent_id IS NOT NULL)
  )
);

CREATE INDEX idx_resource_budget_owner_unit ON resource_budget_policies(user_id, unit, scope_type, period);
CREATE INDEX idx_resource_budget_project ON resource_budget_policies(project_id, unit, period) WHERE project_id IS NOT NULL;
CREATE INDEX idx_resource_budget_run ON resource_budget_policies(run_id, unit, period) WHERE run_id IS NOT NULL;
CREATE INDEX idx_resource_budget_agent ON resource_budget_policies(agent_id, unit, period) WHERE agent_id IS NOT NULL;

CREATE TABLE resource_usage_records (
  id TEXT PRIMARY KEY,
  reservation_group_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  provider TEXT,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  research_report_id TEXT REFERENCES research_reports(id) ON DELETE SET NULL,
  usage_record_id TEXT REFERENCES usage_records(id) ON DELETE SET NULL,
  tool_invocation_id TEXT REFERENCES tool_invocations(id) ON DELETE SET NULL,
  model_id TEXT,
  tool_name TEXT,
  unit TEXT NOT NULL CHECK (unit IN ('model_calls','input_tokens','output_tokens','tool_calls','task_starts')),
  reserved_units INTEGER NOT NULL CHECK (reserved_units >= 0),
  consumed_units INTEGER CHECK (consumed_units IS NULL OR consumed_units >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved','consumed','released')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  reservation_expires_at TEXT
);

CREATE INDEX idx_resource_usage_admission ON resource_usage_records(user_id, unit, status, created_at);
CREATE INDEX idx_resource_usage_project ON resource_usage_records(project_id, unit, status, created_at);
CREATE INDEX idx_resource_usage_provider ON resource_usage_records(provider, unit, status, created_at);
CREATE INDEX idx_resource_usage_run ON resource_usage_records(run_id, unit, status, created_at);
CREATE INDEX idx_resource_usage_agent ON resource_usage_records(agent_id, unit, status, created_at);
CREATE INDEX idx_resource_usage_task ON resource_usage_records(task_id, unit, status, created_at);
CREATE INDEX idx_resource_usage_expiry ON resource_usage_records(reservation_expires_at, status) WHERE status = 'reserved';
CREATE UNIQUE INDEX idx_resource_usage_model_unit ON resource_usage_records(usage_record_id, unit)
  WHERE usage_record_id IS NOT NULL;
CREATE UNIQUE INDEX idx_resource_usage_tool_call ON resource_usage_records(tool_invocation_id, unit)
  WHERE tool_invocation_id IS NOT NULL AND unit = 'tool_calls';
CREATE UNIQUE INDEX idx_resource_usage_task_start ON resource_usage_records(attempt_id, unit)
  WHERE attempt_id IS NOT NULL AND unit = 'task_starts';
