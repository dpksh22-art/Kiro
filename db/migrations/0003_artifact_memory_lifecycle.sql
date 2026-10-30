CREATE TABLE project_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('instruction','decision')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  trust_level TEXT NOT NULL DEFAULT 'trusted_user' CHECK (trust_level = 'trusted_user'),
  provenance TEXT NOT NULL DEFAULT 'explicit_user' CHECK (provenance = 'explicit_user'),
  retention_policy TEXT NOT NULL DEFAULT 'permanent' CHECK (retention_policy IN ('permanent','30_days','90_days')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((retention_policy = 'permanent' AND expires_at IS NULL) OR (retention_policy <> 'permanent' AND expires_at IS NOT NULL))
);

CREATE INDEX idx_project_memories_owner_project ON project_memories(user_id, project_id, updated_at DESC);
CREATE INDEX idx_project_memories_expiry ON project_memories(expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE artifacts ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'quarantined'
  CHECK (upload_state IN ('quarantined','clean','deleting'));
ALTER TABLE artifacts ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (scan_status IN ('pending','clean','rejected','error'));
ALTER TABLE artifacts ADD COLUMN scanner_name TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE artifacts ADD COLUMN retention_expires_at TEXT;
ALTER TABLE artifacts ADD COLUMN updated_at TEXT;
UPDATE artifacts SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX idx_artifacts_owner_state ON artifacts(user_id, upload_state, created_at DESC);
CREATE INDEX idx_artifacts_storage_path ON artifacts(storage_path);

CREATE TABLE attachments_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  content_hash TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO attachments_v2 (id, user_id, message_id, artifact_id, filename, media_type, byte_size, content_hash, storage_path, created_at)
SELECT a.id, a.user_id, a.message_id,
  CASE WHEN EXISTS (SELECT 1 FROM artifacts ar WHERE ar.id = a.artifact_id) THEN a.artifact_id ELSE NULL END,
  a.filename, a.media_type, a.byte_size, a.content_hash, a.storage_path, a.created_at
FROM attachments a;

DROP TABLE attachments;
ALTER TABLE attachments_v2 RENAME TO attachments;
CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_artifact ON attachments(artifact_id);
