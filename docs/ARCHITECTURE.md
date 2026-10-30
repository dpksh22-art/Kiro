# Architecture

## System shape

NEXUS is a TypeScript modular monolith. The browser communicates with authenticated Next.js route handlers. SQLite is the durable control plane. An embedded worker claims persisted tasks using leases. All provider credentials remain server-side.

```text
Browser
  ├─ Server-rendered workspace and Better Auth session
  ├─ POST /api/v1/chat ───────────────┐
  ├─ POST /api/v1/runs                │
  └─ GET  /api/v1/runs/:id/events     │
                                      ▼
Next.js modular monolith
  ├─ Workspace: projects, conversations, messages, explicit trusted memory
  ├─ Artifacts: streamed admission, scanning/quarantine, local SHA-256 blobs
  ├─ Gateway: canonical multipart/tool/schema contracts, provider adapters, discovery, usage, budgets
  ├─ Orchestrator: runs, dynamic DAG, bounded turn loop, read-only/internal broker, durable collaboration, attempts, events, leases
  ├─ Research: policy, pinned fetch, extraction, provenance
  ├─ GitHub: token broker, REST reads, confirmed writes
  └─ Core: auth, encryption, audit, configuration
                                      │
              SQLite WAL + local content-addressed artifacts
```

## Trust boundaries

- The browser never receives provider or GitHub credentials.
- Route handlers derive ownership from the authenticated session, not request bodies.
- Provider responses, model output, webpages, repository content, and tool output are untrusted data.
- Provider adapters translate one network request. They do not authorize or execute tools.
- The trusted orchestrator controls task state, budget admission, permissions, retries, cancellation, and completion.
- GitHub writes require a specific repository, validated payload, explicit browser confirmation, and a payload-bound operation key. Branch, file-change, and draft-PR operations persist their recovery state and never force-update refs.

## Gateway flow

1. A user stores a credential. AES-256-GCM encrypts it with `NEXUS_MASTER_KEY`.
2. Validation calls the official model-list endpoint and persists only returned model IDs and metadata.
3. Chat verifies ownership and model availability, injects bounded explicit trusted memory, and replays bounded completed history.
4. Budget admission atomically inserts monetary and resource reservations before each provider turn. One model call, estimated input tokens, and requested maximum output tokens are reserved together.
5. The gateway validates requested schemas locally against a bounded keyword subset, then the selected adapter maps canonical multipart messages, tool definitions/results, and JSON Schema formats to its native surface and emits canonical text, tool-call, structured-output, usage, and completion events.
6. Every structured completion is validated again with Ajv against the exact requested schema. Size, depth, node, property, enum, combinator, and output-complexity limits reject unsafe schemas and responses before application persistence.
7. Unsupported request shapes, unresolved artifact references, malformed/incomplete tool calls, and streams without terminal evidence fail closed.
8. Chat persists the final answer. Agent turns either finish or pass canonical tool calls to the separate deterministic broker.

The internal request/event contract is provider-neutral. Model-level capabilities use `supported`, `unsupported`, `conditional`, or `unknown`. Missing price is never interpreted as zero.

## Durable agent flow

A run contains tasks, dependency edges, and a snapshotted participant registry. Root tasks start `ready`; synthesis starts `blocked`. A worker transaction claims a ready task, writes an attempt, sets a fencing token, and establishes a 45-second lease. Heartbeats extend the lease and update attempt liveness. Each task executes a bounded provider/tool loop using stored turn, duration, tool, permission, budget, and output-schema values.

The broker authorizes three fixed external-data reads and two internal orchestration effects. Durable messages are owner/run/task/attempt fenced, recipient-targeted, expiring, hop-bounded, and idempotent. The runtime appends pending inbox rows to canonical context under an explicit untrusted label, then acknowledges those rows transactionally. Messages never enter trusted memory or broker authorization.

Delegation atomically creates a child task, increments depth, snapshots the recipient agent, inherits the parent model target, records parent/fingerprint/idempotency state, and inserts a terminal dependency from synthesis to the child. SQLite transaction serialization prevents synthesis from racing the dependency insert. The scheduler continues to enforce run parallelism; task/depth counts and deadline/cancellation are checked before insertion. Synthesis queries all participating tasks and unexpired material messages, preserving parent/child identity, correlations, and disagreements.

Every provider turn reserves monetary cost, estimated input tokens, and the requested output maximum. The linked `model_calls` unit is consumed when adapter dispatch begins. A terminal response settles provider usage immediately before later tool execution or local validation. Only work proven not dispatched releases; post-dispatch lease expiry, cancellation, deadlines, validation failure, and ambiguous network outcomes consume conservative estimates with an unknown accounting outcome. The worker consumes one `task_starts` unit in the task-claim transaction, and the broker consumes one `tool_calls` unit immediately before validated execution. A typed `budget_exceeded` failure is terminal and never selects a silent fallback. Run-scoped records are shared by initial and delegated children, while stored agent per-run caps use the snapshotted participant budget across all of that agent's tasks. Repeated call fingerprints and empty responses stop no-progress loops. Internal message/delegation effects remain idempotent, while provider network effects remain **at least once** across ambiguous failures.

## Persistence

`db/migrations/0001_core.sql` defines the original application schema. `0002_security_and_usage.sql` adds single-owner and usage controls. `0003_artifact_memory_lifecycle.sql` adds explicit project memory, artifact scan/upload state, artifact lifecycle indexes, and repairs `attachments.artifact_id` with `ON DELETE SET NULL`; pre-existing orphan attachment references become null during the table rebuild. `0004_github_write_operations.sql` adds the owner-scoped GitHub write-intent ledger and recovery state. `0005_gateway_tool_loop.sql` links tool invocations to attempts and provider call IDs, stores canonical argument fingerprints and update/truncation metadata, and adds attempt/call indexes. `0006_agent_messaging_delegation.sql` activates message delivery state, expiry and dedupe indexes, adds snapshotted run participants, and records idempotent parent/child delegations. `0007_evidence_aware_research.sql` adds research status, model provenance, synthesis/verification/failure fields, normalized report-source membership, and research-linked usage. `0008_resource_budgets.sql` adds normalized owner/project/provider/run/agent resource policies, the linked resource reservation ledger, resource indexes, and monetary reservation expiry metadata. `0009_account_deletion.sql` adds resumable account-deletion jobs. `0010_security_reliability_boundaries.sql` adds dispatch/outcome accounting, provider validation generations, and durable owner quiescence.

Artifact bytes live under the operator-configured `NEXUS_ARTIFACT_ROOT` as `sha256/<prefix>/<digest>`. Client filenames are metadata only. Upload, delete, and online-backup snapshot work share one public mutation lock so a backup database cannot reference a blob removed during its copy. SQLite's online backup API creates a consistent database image without copying a live WAL file. A version-2 manifest binds that image to migration hashes, row counts, and the exact referenced artifact tree. HMAC-SHA256 under the separately protected `NEXUS_BACKUP_SIGNING_KEY` authenticates the exact manifest bytes before isolated verification trusts them. The bundle is not encrypted; operators must provide encrypted storage.

Project memory is intentionally narrow: only authenticated, explicit owner-created `instruction` and `decision` records can carry `trusted_user` trust. Active records enter chat and agent system context with provenance labels and a 12,000-character cap. External retrieval, artifact text, repository data, tool results, and model output remain separate untrusted data and are never auto-promoted. Time-limited records are excluded after expiry and purged on the next memory read or owner export.

SQLite runs with WAL, foreign keys, a five-second busy timeout, and normal synchronous mode. It is a deliberate single-writer choice for a personal deployment. Migrate to PostgreSQL before active-active application replicas, sustained write concurrency, or regional recovery requirements.

## Streaming

Chat uses a multiplexed SSE response with independent answer IDs. Task events use cursor-based SSE backed by durable `task_events`. Clients reconnect and reconcile with the canonical run snapshot. Browser disconnect cancels an interactive chat call, but it does not delete persisted data or background runs.

## Research

The research subsystem validates protocol, credentials-in-URL, port, DNS answers, and globally routable IPv4 addresses. Native IPv6 retrieval is conservatively disabled in the beta. An Undici agent pins permitted addresses for the connection while TLS still uses the requested hostname. Every redirect receives a fresh validation; authorization is stripped on cross-origin redirects. Responses are time-, byte-, and type-limited. HTML active content is removed before extraction. Records include canonical URL, retrieval time, optional publication time, connector, excerpt, and SHA-256 content hash.

Retrieval always completes before optional synthesis and remains durable if synthesis fails. The service stores report-source membership and builds a bounded packet containing only stored source IDs, hashes, titles, URLs, dates, and excerpts, each explicitly labeled `untrusted_external`. An owner-scoped target must still be connected, available, and advertise structured-output support. Budget admission reserves usage before the tool-free provider call. Ajv validates the strict synthesis shape locally; application checks reject unknown source IDs and invented URLs, deduplicate citations, require a citation per claim, and record conservative meaningful-token overlap for every cited excerpt. Unsupported claims remain visible with `unsupported` verification. Successful report persistence and usage settlement share a transaction; failures release the reservation and retain evidence with a sanitized error.

## GitHub code-change flow

Repository file reads require an explicit ref. The service resolves that ref to a commit SHA before requesting file content, rejects non-file and invalid UTF-8 responses, and limits decoded text to 256 KiB. Tree reads require an explicit tree SHA; compare reads require explicit base and head refs.

A preview returns the exact old and proposed text, current blob SHA, resolved commit SHA, content hash, and canonical proposal hash without writing. Apply accepts one complete text file, not a patch or command. It re-reads the branch and file, rejects the repository's default branch, compares the confirmed blob SHA, and calls the official Contents API. Branch creation uses one non-force ref-create call. Draft PR creation always sets `draft: true` and binds the exact head, base, title, body, and operation marker.

`github_write_operations` separates `prepared`, `pending`, `reconciling`, `completed`, and `failed`. A completed request replays its stored result. A changed payload conflicts. A pending or ambiguous operation must prove the exact remote branch SHA, file content plus commit marker, or draft-PR fields plus marker before completion; otherwise it remains closed to reposting.

## Scale-up path

- PostgreSQL replaces SQLite repositories and enables multiple schedulers with row-level locks.
- Object storage replaces the mounted artifact directory.
- Redis may provide cache and wake-up hints, never canonical task state.
- Temporal becomes appropriate for multi-region, cross-service workflows lasting days or when custom recovery dominates engineering.
- A separate worker image can use the existing task claim/heartbeat/complete contract.

Significant choices are recorded under `docs/adr/`.
