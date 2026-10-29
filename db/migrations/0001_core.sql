CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  encrypted_credential TEXT,
  base_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('unknown','connected','degraded','invalid','disconnected')),
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider, label)
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  context_window INTEGER,
  input_price_micros_per_million INTEGER,
  output_price_micros_per_million INTEGER,
  pricing_currency TEXT,
  availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('available','unavailable','unknown')),
  metadata_source TEXT,
  metadata_observed_at TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, provider_model_id)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('single','parallel','debate','team','review','research','engineering')),
  parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  connection_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
  provider_model_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','streaming','completed','failed','cancelled')),
  content TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  error_message TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_micros INTEGER,
  billed_cost_micros INTEGER,
  provider_request_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  artifact_id TEXT,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  instructions TEXT NOT NULL,
  routing_policy_json TEXT NOT NULL DEFAULT '{}',
  allowed_tools_json TEXT NOT NULL DEFAULT '[]',
  permission_policy_json TEXT NOT NULL DEFAULT '{}',
  budget_json TEXT NOT NULL DEFAULT '{}',
  max_duration_seconds INTEGER NOT NULL DEFAULT 600,
  max_turns INTEGER NOT NULL DEFAULT 12,
  memory_scope TEXT NOT NULL DEFAULT 'project',
  output_schema_json TEXT,
  completion_criteria TEXT NOT NULL DEFAULT '',
  is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, slug)
);

CREATE TABLE agent_teams (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_team_members (
  team_id TEXT NOT NULL REFERENCES agent_teams(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(team_id, agent_id)
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','waiting','paused','cancel_requested','cancelling','succeeded','failed','cancelled')),
  max_parallelism INTEGER NOT NULL DEFAULT 3 CHECK (max_parallelism BETWEEN 1 AND 16),
  max_tasks INTEGER NOT NULL DEFAULT 32 CHECK (max_tasks BETWEEN 1 AND 256),
  max_depth INTEGER NOT NULL DEFAULT 4 CHECK (max_depth BETWEEN 0 AND 16),
  deadline_at TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('blocked','ready','leased','running','waiting','retry_wait','succeeded','failed','cancel_requested','cancelled','skipped')),
  depth INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 50,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  ready_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(run_id, task_key)
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL DEFAULT 'success' CHECK (predicate IN ('success','terminal')),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  PRIMARY KEY(task_id, depends_on_task_id),
  CHECK(task_id <> depends_on_task_id)
);

CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  worker_id TEXT,
  lease_token TEXT,
  started_at TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  usage_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE(task_id, attempt_number)
);

CREATE TABLE task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  sender_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  recipient_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  message_type TEXT NOT NULL,
  correlation_id TEXT,
  reply_to_id TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
  hop_count INTEGER NOT NULL DEFAULT 0,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE tool_invocations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  permission_scope TEXT NOT NULL,
  status TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  result_json TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE research_sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  connector TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT,
  canonical_url TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  excerpt TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  trust_level TEXT NOT NULL DEFAULT 'untrusted_external',
  UNIQUE(user_id, canonical_url, content_hash)
);

CREATE TABLE research_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  citation_map_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE github_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  connection_type TEXT NOT NULL,
  encrypted_token TEXT,
  installation_id TEXT,
  login TEXT,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE budget_policies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT,
  period TEXT NOT NULL CHECK (period IN ('task','daily','monthly')),
  hard_limit_micros INTEGER NOT NULL CHECK (hard_limit_micros >= 0),
  soft_limit_micros INTEGER CHECK (soft_limit_micros IS NULL OR soft_limit_micros >= 0),
  behavior TEXT NOT NULL CHECK (behavior IN ('stop','wait','fallback')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_micros INTEGER,
  billed_cost_micros INTEGER,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved','settled','released','unknown')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  outcome TEXT NOT NULL,
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(user_id, route, idempotency_key)
);

CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_provider_connections_user ON provider_connections(user_id, status);
CREATE INDEX idx_models_connection ON models(connection_id, availability);
CREATE INDEX idx_projects_user_updated ON projects(user_id, updated_at DESC);
CREATE INDEX idx_conversations_project_updated ON conversations(project_id, updated_at DESC);
CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at);
CREATE INDEX idx_agents_user ON agents(user_id, is_template);
CREATE INDEX idx_runs_user_status ON task_runs(user_id, status, updated_at DESC);
CREATE INDEX idx_tasks_ready ON tasks(status, priority DESC, ready_at) WHERE status = 'ready';
CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at) WHERE status IN ('leased','running','cancel_requested');
CREATE INDEX idx_task_dependencies_prereq ON task_dependencies(depends_on_task_id);
CREATE INDEX idx_task_events_run_sequence ON task_events(run_id, sequence);
CREATE INDEX idx_artifacts_user_created ON artifacts(user_id, created_at DESC);
CREATE INDEX idx_sources_run ON research_sources(run_id, retrieved_at DESC);
CREATE INDEX idx_usage_user_created ON usage_records(user_id, created_at DESC);
CREATE INDEX idx_audit_user_created ON audit_events(user_id, created_at DESC);
