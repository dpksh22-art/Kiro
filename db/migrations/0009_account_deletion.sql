CREATE TABLE account_deletion_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  owner_user_id_hash TEXT NOT NULL UNIQUE CHECK (length(owner_user_id_hash) = 64),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending','deleting_files','completed','failed')),
  data_row_count INTEGER NOT NULL DEFAULT 0 CHECK (data_row_count >= 0),
  artifact_count INTEGER NOT NULL DEFAULT 0 CHECK (artifact_count >= 0),
  attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
  unique_path_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_path_count >= 0),
  removed_path_count INTEGER NOT NULL DEFAULT 0 CHECK (removed_path_count >= 0),
  missing_path_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_path_count >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sanitized_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE account_deletion_files (
  job_id TEXT NOT NULL REFERENCES account_deletion_jobs(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending','removed','missing')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id, storage_path)
);

CREATE INDEX idx_account_deletion_jobs_recovery
  ON account_deletion_jobs(state, updated_at)
  WHERE state IN ('pending','deleting_files','failed');
