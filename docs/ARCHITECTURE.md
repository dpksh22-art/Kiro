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
  ├─ Workspace: projects, conversations, messages
  ├─ Gateway: connections, adapters, discovery, usage, budgets
  ├─ Orchestrator: runs, DAG, tasks, attempts, events, leases
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
- GitHub writes require a specific repository, validated payload, explicit browser confirmation, and operation idempotency where implemented.

## Gateway flow

1. A user stores a credential. AES-256-GCM encrypts it with `NEXUS_MASTER_KEY`.
2. Validation calls the official model-list endpoint and persists only returned model IDs and metadata.
3. Chat verifies ownership and model availability.
4. Budget admission inserts a transactional usage reservation.
5. The selected adapter produces canonical start, text-delta, usage, and completion events.
6. A provider stream without its required terminal marker fails.
7. NEXUS persists the final answer and settles or releases the usage reservation.

The internal request/event contract is provider-neutral. Model-level capabilities use `supported`, `unsupported`, `conditional`, or `unknown`. Missing price is never interpreted as zero.

## Durable agent flow

A run contains tasks and dependency edges. Root tasks start `ready`; synthesis starts `blocked`. A worker transaction claims a ready task, writes an attempt, sets a fencing token, and establishes a 45-second lease. Heartbeats extend the lease. Stored agent duration limits abort long calls. Expired running tasks retry within bounds; expired cancelled tasks finalize as cancelled. Completion writes task output and events before dependencies are refreshed.

Current external-effect guarantee: **at least once**. NEXUS does not claim exactly-once provider calls. A provider request can be billed despite an ambiguous timeout.

## Persistence

`db/migrations/0001_core.sql` defines users/auth identities, provider connections, model registry, projects, conversations, messages, attachments, agents, teams, runs, tasks, dependencies, attempts, events, agent messages, artifacts, tools, research, GitHub connections, budgets, usage, audits, notifications, idempotency, and system configuration.

SQLite runs with WAL, foreign keys, a five-second busy timeout, and normal synchronous mode. It is a deliberate single-writer choice for a personal deployment. Migrate to PostgreSQL before active-active application replicas, sustained write concurrency, or regional recovery requirements.

## Streaming

Chat uses a multiplexed SSE response with independent answer IDs. Task events use cursor-based SSE backed by durable `task_events`. Clients reconnect and reconcile with the canonical run snapshot. Browser disconnect cancels an interactive chat call, but it does not delete persisted data or background runs.

## Research

The research subsystem validates protocol, credentials-in-URL, port, DNS answers, and globally routable IPv4 addresses. Native IPv6 retrieval is conservatively disabled in the beta. An Undici agent pins permitted addresses for the connection while TLS still uses the requested hostname. Every redirect receives a fresh validation; authorization is stripped on cross-origin redirects. Responses are time-, byte-, and type-limited. HTML active content is removed before extraction. Records include canonical URL, retrieval time, optional publication time, connector, excerpt, and SHA-256 content hash.

## Scale-up path

- PostgreSQL replaces SQLite repositories and enables multiple schedulers with row-level locks.
- Object storage replaces the mounted artifact directory.
- Redis may provide cache and wake-up hints, never canonical task state.
- Temporal becomes appropriate for multi-region, cross-service workflows lasting days or when custom recovery dominates engineering.
- A separate worker image can use the existing task claim/heartbeat/complete contract.

Significant choices are recorded under `docs/adr/`.
