# NEXUS AI OS implementation backlog

Updated: 2026-10-29

Statuses: `done`, `in-progress`, `blocked`, `queued`.

| ID | Priority | Description | Dependencies | Owner | Status | Acceptance and evidence |
|---|---:|---|---|---|---|---|
| NX-001 | P0 | Discover repository, tools, credentials, and constraints | — | Principal Architect | done | Empty unborn `main`; branch `feat/nexus-ai-os`; Node 22; open internet; GitHub admin metadata, sensitive endpoints restricted. |
| NX-002 | P0 | Research architecture, gateway, orchestration, UX, research, GitHub, security, QA | NX-001 | Research organization | done | Ten independent specialist reports completed 2026-10-29; decisions summarized in `docs/RESEARCH.md`. |
| NX-003 | P0 | Scaffold typed web application, CI, migration and deployment foundation | NX-001, NX-002 | Orchestrator | done | Clean migration, lint, typecheck, 28 tests, build, and standalone smoke pass. |
| NX-004 | P0 | Implement authentication, authorization, encrypted secrets, audit | NX-003 | Backend/Security | done | Better Auth protected routes; atomic single-owner trigger; AES-GCM; tenant predicates; audit redaction. |
| NX-005 | P0 | Implement provider-neutral model gateway and registry | NX-003, NX-004 | Gateway | done | Eight provider profiles, discovery, normalized streaming/errors, terminal validation, capabilities, sourced pricing. Mock contract tested; live credentials blocked. |
| NX-006 | P0 | Implement projects, conversations, messages and parallel model mode | NX-004, NX-005 | Frontend/Backend | done | Persistent chat, independent multiplexed model streams, errors, usage, and client cancellation implemented. |
| NX-007 | P0 | Implement durable agent task DAG and event stream | NX-004, NX-005 | Orchestration | done | Persisted tasks/dependencies/events, concurrent claims, leases, retries, deadlines, cancellation and recovery verified. |
| NX-008 | P1 | Implement research connectors and citation provenance | NX-004, NX-007 | Research Engineering | done | Web, RSS/Atom, HN, GitHub and optional Tavily; pinned IPv4-only egress, extraction, hashes and citations. |
| NX-009 | P1 | Implement GitHub read and approved write workflows | NX-004, NX-007 | GitHub Engineering | in-progress | REST repository/issues/PR/CI reads and confirmed branch/issue/PR writes implemented; sandbox credential read access verified outside app; application write smoke pending. |
| NX-010 | P0 | Add budgets, usage ledger and backend enforcement | NX-005, NX-007 | Gateway/Backend | done | Atomic reservations/settlement, USD sourced pricing, provider/global/project/task scopes, fail-closed unknown price. |
| NX-011 | P0 | Complete unit, integration and browser verification | NX-004–NX-010 | QA | done | 28 unit/integration, 3 browser, and 1 production smoke checks pass; results in `docs/TESTING.md`. |
| NX-012 | P0 | Threat-model review and security fixes | NX-004–NX-010 | Security | done | Independent final review approved the documented beta boundary; historical findings retained in `semantic-review/`. |
| NX-013 | P1 | Container deployment and operational documentation | NX-003–NX-012 | Release | done | Non-root image/Compose, migration-first standalone entrypoint, readiness, volume, backup and upgrade docs; container runtime blocked by missing conmon. |
| NX-014 | P2 | PostgreSQL/Redis horizontal-scale profile | NX-013 | Backend | blocked | Deferred until multi-node scale is required; SQLite single-writer deployment is intentional for initial personal deployment. |
| NX-015 | P2 | Reddit and X connectors | NX-008 | Research | blocked | Requires approved OAuth/API access and platform-specific compliance workflows. |
| NX-016 | P2 | Live provider smoke tests | NX-005 | QA | blocked | Run only for credentials found through configuration; never infer entitlement. |
