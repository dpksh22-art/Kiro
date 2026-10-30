# Deployment and operations

## Supported initial topology

One NEXUS application process, one persistent local volume, and outbound HTTPS access to configured providers/research sources. Do not run multiple writing replicas against the same SQLite file, including over NFS.

## Docker Compose

1. Copy `.env.example` to `.env`.
2. Generate independent high-entropy values for `BETTER_AUTH_SECRET`, `NEXUS_MASTER_KEY`, `NEXUS_BACKUP_SIGNING_KEY`, and `NEXUS_BOOTSTRAP_TOKEN`.
3. Set `BETTER_AUTH_URL` to the exact externally visible HTTPS origin.
4. Keep the bootstrap token private and remove it from the runtime environment after the owner account is created.
5. Run `docker compose up --build -d`.
6. Check `GET /api/health/live` and `GET /api/health/ready`.
7. Create the first account with the bootstrap token.

The image runs as UID/GID 1001, drops Linux capabilities in Compose, prevents privilege escalation, uses a read-only root filesystem, mounts `/app/data`, runs migrations before accepting application traffic, and exposes a readiness health check.

Terminate TLS at a maintained reverse proxy or managed load balancer. Forward the original HTTPS scheme and host. Restrict the application to trusted ingress and apply outbound firewall/egress-proxy rules.

## Environment

Required in production:

- `BETTER_AUTH_URL`: exact public origin.
- `BETTER_AUTH_SECRET`: at least 32 high-entropy characters.
- `NEXUS_MASTER_KEY`: base64-encoded 32-byte credential-encryption key.
- `NEXUS_BACKUP_SIGNING_KEY`: a separate base64 value decoding to at least 32 bytes. It authenticates backup manifests and must be retained outside every bundle and separately from storage-encryption keys.
- `NEXUS_DATABASE_PATH`: absolute persistent local path, default `/app/data/nexus.db` in the image. Relative production paths are rejected because the migration and standalone server can have different working directories.
- `NEXUS_ARTIFACT_ROOT`: absolute persistent local directory, default `/app/data/artifacts` in the image. It must be on the same backed-up volume as the database for the supported deployment.
- `NEXUS_ARTIFACT_QUOTA_BYTES`: logical per-owner artifact quota; defaults to 1 GiB and cannot be configured below the 10 MiB per-upload ceiling.

Required only for account creation:

- `NEXUS_BOOTSTRAP_TOKEN`: at least 24 characters. It authorizes creation of the single database-enforced owner account.

Optional provider and connector variables are listed in `.env.example`.

## Backups and restore verification

Create a live backup into an absolute operator-controlled directory:

```bash
npm run backup -- /absolute/path/to/backup-root
```

The command uses the `better-sqlite3` online backup API while the application remains in WAL mode. It creates a new mode-0700 `nexus-backup-<timestamp>-<id>` directory and never overwrites an existing bundle. Artifact upload/delete mutations pause while the database snapshot and every referenced content-addressed blob are copied. Version 2 records migration IDs and hashes, selected non-secret row counts, the database hash, and every referenced artifact hash and size. It authenticates the exact manifest bytes with HMAC-SHA256 under the separately protected `NEXUS_BACKUP_SIGNING_KEY`; that key is never stored in the bundle. The manifest contains no environment values, key material, credential plaintext, or credential ciphertext. The bundle is authenticated, not encrypted. Keep it on operator-managed encrypted storage, and retain both `NEXUS_MASTER_KEY` and `NEXUS_BACKUP_SIGNING_KEY` separately.

The command refuses relative targets, targets that overlap live data, existing symlink components, malformed artifact paths, missing or changed blobs, conflicting metadata, and incomplete artifact deletion state.

Verify a bundle without changing current data:

```bash
npm run restore:verify -- /absolute/path/to/nexus-backup-...
```

Verification first authenticates the exact manifest bytes in constant time with `NEXUS_BACKUP_SIGNING_KEY`, before parsing or trusting any manifest field. It then copies the database and artifact tree into a new disposable mode-0700 directory and checks the public checksum, database and artifact hashes, SQLite quick/integrity/foreign-key checks, migration IDs and file hashes, and row counts. Missing or wrong signing keys fail closed. When `NEXUS_MASTER_KEY` is present, verification also authenticates every stored provider and GitHub credential envelope without printing plaintext. Bundle confidentiality and storage encryption remain the operator's responsibility.

The verifier never overwrites live data. Production recovery remains an offline operator action: stop the sole writer, verify the bundle, restore it into a new database/artifact generation, atomically switch configured paths or the persistent volume, start one writer, and retain the previous generation for rollback.

Recommended schedule for personal production:

- Daily authenticated backup bundle on operator-managed encrypted storage.
- Seven daily, five weekly, and twelve monthly restore points.
- Quarterly isolated verification plus an offline cutover drill.

A restore drill is successful only when verification passes, readiness starts on the restored generation, the owner can sign in, stored credentials authenticate with the separately supplied key, project counts match, and a historical run can be inspected.

## Account deletion and replacement owner

The Settings danger zone is the supported whole-account deletion path. Export first, revoke provider and GitHub credentials at their issuers, then submit the current password and exact confirmation phrase. NEXUS removes local credential ciphertext; it does not claim remote revocation.

Deletion first atomically marks the durable owner runtime state `quiescing`. Every chat, research, agent, tool, delegation, provider-validation, and integration admission checks that state. Deletion cancels durable runs/tasks, aborts all registered owner operations, conservatively accounts any dispatched provider request, and waits boundedly for active operations and leases to drain before removing artifact bytes, credentials, and the user. Startup resumes jobs left quiescing by a crash. A failure reactivates the retained owner only when no active operation or lease remains; otherwise the owner stays quiesced for safe retry. A completed job leaves only redacted owner-null audit records and a non-secret count/timestamp tombstone.

After completed deletion, the single-owner trigger naturally permits one replacement owner. Restore a high-entropy `NEXUS_BOOTSTRAP_TOKEN` to the runtime environment, restart the sole application process, create the replacement account, then remove the token and restart again. An incomplete deletion still has an owner and blocks replacement signup.

The migration command creates a migration-only Better Auth instance without importing the runtime singleton. It suppresses schema validation only for that instance while a pristine database is being created; normal production request startup keeps Better Auth schema validation enabled.

## Upgrade

1. Back up database, artifacts, and current image digest.
2. Build the new immutable image from a reviewed commit.
3. Stop the single writer.
4. Start the new image; `start:production` applies forward migrations before Next.js starts.
5. Verify readiness, authentication, provider status, research retrieval, and an existing run.
6. Keep the prior image and backup until the monitoring window closes.

Database migrations are forward-only in the initial release. Restore the pre-upgrade backup to roll back a destructive or incompatible migration.

## Scale triggers

Move to PostgreSQL and a separate worker before any of these:

- More than one active application replica.
- Sustained write-lock contention.
- Hundreds of concurrent task starts.
- Multi-region recovery requirements.
- Workflows spanning many services for days.

Temporal is a later option for long-lived cross-service workflows, not a current dependency.

## Deployment status

The Docker and Compose configuration is implemented. CI now builds the image and is configured to prove health plus a database marker across a named-volume restart. The local sandbox has no working container runtime, so this report does not claim a locally observed container result. No external staging or production target was present, so no remote deployment occurred.
