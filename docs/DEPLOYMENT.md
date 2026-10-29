# Deployment and operations

## Supported initial topology

One NEXUS application process, one persistent local volume, and outbound HTTPS access to configured providers/research sources. Do not run multiple writing replicas against the same SQLite file, including over NFS.

## Docker Compose

1. Copy `.env.example` to `.env`.
2. Generate independent high-entropy values for `BETTER_AUTH_SECRET`, `NEXUS_MASTER_KEY`, and `NEXUS_BOOTSTRAP_TOKEN`.
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
- `NEXUS_MASTER_KEY`: base64-encoded 32-byte key.
- `NEXUS_DATABASE_PATH`: absolute persistent local path, default `/app/data/nexus.db` in the image. Relative production paths are rejected because the migration and standalone server can have different working directories.

Required only for account creation:

- `NEXUS_BOOTSTRAP_TOKEN`: at least 24 characters. It authorizes creation of the single database-enforced owner account.

Optional provider and connector variables are listed in `.env.example`.

## Backups

Back up both the SQLite database and artifact directory from the same logical point. For a live database, use SQLite's online backup API or `sqlite3 /app/data/nexus.db ".backup '/backup/nexus.db'"`; do not copy only the main file while WAL writes are active. Encrypt backups and store `NEXUS_MASTER_KEY` separately.

Recommended schedule for personal production:

- Daily encrypted database backup.
- Daily artifact synchronization.
- Seven daily, five weekly, and twelve monthly restore points.
- Quarterly restore drill into an isolated environment.

A restore is successful only when readiness passes, the owner can sign in, an encrypted connection can be decrypted, project counts match, and a historical run can be inspected.

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

The Docker and Compose configuration is implemented. No external staging or production target was present in the connected environment, so no remote deployment occurred.
