CREATE TABLE github_write_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('branch','code_change','draft_pull_request')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('prepared','pending','reconciling','completed','failed')),
  branch_name TEXT,
  base_ref TEXT,
  file_path TEXT,
  expected_file_sha TEXT,
  base_commit_sha TEXT,
  result_file_sha TEXT,
  result_commit_sha TEXT,
  external_id TEXT,
  external_url TEXT,
  response_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(user_id, operation_type, idempotency_key)
);

CREATE INDEX idx_github_write_operations_owner_repo
  ON github_write_operations(user_id, repo_owner, repo_name, updated_at DESC);
CREATE INDEX idx_github_write_operations_recovery
  ON github_write_operations(state, updated_at)
  WHERE state IN ('pending','reconciling');
