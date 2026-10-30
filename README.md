# NEXUS AI OS

NEXUS is a self-hosted, multi-model AI workspace with encrypted provider connections, direct streaming inference, side-by-side model comparison, persisted agent teams, evidence-backed research, GitHub REST integration, usage records, and backend-enforced budgets.

This repository contains a functioning single-node application. It does not include model API entitlements, paid search access, or a hosted production environment.

## Implemented

- Better Auth email/password sessions and protected application/API routes.
- Owner bootstrap token and a database-enforced single owner account.
- AES-256-GCM server-side encryption for provider and GitHub credentials.
- Provider adapters for OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Mistral, OpenRouter, and Ollama.
- On-demand model discovery with bounded Anthropic/Gemini pagination and generation-fenced complete-snapshot reconciliation. Unknown capabilities, context limits, and prices remain unknown.
- Single-model and parallel-model streaming chat with independent status and failure handling.
- Durable projects, conversations, messages, usage, audit events, task runs, explicit trusted project memory, and locally stored artifacts.
- Authenticated artifact upload/download/delete with a 10 MiB stream limit, SHA-256 content addressing, per-owner quota, conservative MIME detection, quarantine state, and reference-aware blob cleanup.
- Streaming owner JSON export, local credential disconnect, audited scoped deletion, and resumable whole-account deletion with durable owner quiescence, active-call abort/drain, current-password verification, and locked artifact cleanup.
- Fourteen built-in templates plus UI-created custom agents with safe tool, turn, duration, permission, and output-schema configuration.
- Provider-neutral text, image-URL, clean-artifact-reference, tool, and JSON Schema contracts with explicit per-provider capabilities, OpenAI strict nullable normalization, Anthropic wire-subset translation with exact local validation, and bounded stream/frame/output parsing.
- A deterministic read-only agent tool broker for SSRF-protected web fetches, authenticated GitHub repository overviews, and clean owner-owned text/JSON artifacts.
- Bounded multi-turn agent execution with per-turn usage reservations, tool-call limits, repeated-call detection, deadlines, cancellation, durable invocation audits, and human-readable traces.
- Owner-scoped durable agent messaging and idempotent internal delegation with active recipient checks, reply/correlation integrity, expiry, hop/task/depth limits, parent/child task links, and synthesis gating.
- Explicit trusted project memory injection and bounded persisted conversation replay.
- Research connectors for direct webpages, RSS/Atom, Hacker News, public GitHub repositories, and optional Tavily discovery.
- Evidence-only or optional model-backed research synthesis with bounded untrusted evidence packets, strict locally validated JSON Schema, source-ID citation checks, conservative excerpt-overlap verification, preserved connector failures, and linked usage records.
- SSRF controls, DNS pinning, redirect revalidation, active-content removal, size limits, source hashes, and citation records.
- GitHub repository/branch/issue/PR/Actions reads, immutable UTF-8 file inspection, exact before/after previews, idempotent non-default branch creation, one-file Contents API changes with SHA compare-and-swap, and draft PR creation through official REST APIs. Every external write requires confirmation and an operation key; NEXUS never merges automatically.
- Transactional monetary and non-monetary budget admission. Resource policies cover model calls, input/output tokens, broker calls, and task starts across owner, project, provider, run, and agent scopes. Unknown prices fail closed when a monetary limit applies.
- Online SQLite backup bundles with coordinated artifact snapshots, HMAC-authenticated versioned manifests, and isolated restore verification. Bundles are not encrypted; operators remain responsible for encrypted storage.
- Responsive dark/light workstation interface with honest empty, disconnected, running, failed, and cancelled states.
- SQLite WAL single-writer deployment, migrations through `0010_security_reliability_boundaries.sql`, health checks, production-only runtime dependencies, Docker/Compose configuration, full-lockfile and final-image audit gates, CI, and automated tests. GitHub Actions run `40995585894` verified the image, audit, readiness, and named-volume restart persistence.

## Quick start

Requirements: Node.js 22.13 or later and npm.

```bash
npm ci
cp .env.example .env
```

Generate four independent secrets:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # NEXUS_MASTER_KEY
openssl rand -base64 32   # NEXUS_BACKUP_SIGNING_KEY (keep outside bundles)
openssl rand -hex 24      # NEXUS_BOOTSTRAP_TOKEN
```

Edit `.env`, then:

```bash
set -a && . ./.env && set +a
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`, choose **Sign up**, and enter `NEXUS_BOOTSTRAP_TOKEN` with the owner account. The database trigger atomically permits exactly one account.

### Connect a model

1. Open **Provider Connections**.
2. Choose a provider, enter an API key, and save.
3. Select **Validate**. NEXUS follows the provider's bounded model-list pagination and atomically stores only a complete, generation-current snapshot.
4. Open **Unified Chat** and select one discovered model, or select two to four models for parallel comparison.

Ollama uses `OLLAMA_BASE_URL` and does not require an API key. The endpoint is configured by the server operator, not supplied by browser input.

### Run an agent team

Open **Agent Teams**, select agents and models, enter a goal, and start a run. Independent tasks execute concurrently. Agents with an explicit internal allowlist and `read_only_or_internal` policy may send bounded messages or delegate child work. A synthesis task remains blocked until every initial and delegated dependency terminates. The run page shows parent/child tasks, message correlation and delivery state, and durable events; the owner can send a non-authoritative `explicit_user` message to an active participating agent. Refreshing or closing the browser does not remove task or message state. The embedded worker resumes eligible database work after application restart.

### Research

Open **Research Lab** and add up to ten complementary public webpage, RSS/Atom, Hacker News, GitHub `owner/repository`, or Tavily source requests. Evidence-only mode performs no model call. A discovered connected model with structured-output support can optionally synthesize the stored evidence; NEXUS locally validates its schema, source IDs, URLs, and excerpt overlap, and preserves the evidence if synthesis fails. Tavily returns a configuration error until `TAVILY_API_KEY` is set. Reddit and X connectors are not implemented: both require platform API approval and compliance work, so credentials alone are insufficient.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start local development. |
| `npm run db:migrate` | Apply Better Auth and NEXUS migrations. |
| `npm run lint` | Run ESLint. |
| `npm run typecheck` | Run strict TypeScript checks. |
| `npm test` | Run deterministic unit and database integration tests. |
| `npm run test:e2e` | Run Playwright authentication, authorization, and live public-web research flows. |
| `npm run test:persistence` | Restart the standalone server against one database and verify retained state. |
| `npm run build` | Build the production application. |
| `npm run start:production` | Apply migrations and start the supported standalone server entrypoint. |
| `npm run backup -- <absolute-dir>` | Create a versioned online database and artifact backup bundle. |
| `npm run restore:verify -- <absolute-bundle-dir>` | Verify a bundle in disposable isolated paths without changing live data. |
| `npm run check` | Run lint, typecheck, unit/integration tests, and build. |

## Architecture

NEXUS is a modular monolith on Next.js 16 and Node.js 22. SQLite is the initial durable system of record for a personal single-node deployment. The provider gateway, task runtime, research connectors, and GitHub integration have owned interfaces and tables. GitHub write intents use payload-bound operation keys and reconcile exact remote identifiers before retry; provider calls retain the documented at-least-once boundary.

See [Architecture](docs/ARCHITECTURE.md), [Costs and resource accounting](docs/COSTS.md), [Providers](docs/PROVIDERS.md), [Agents](docs/AGENTS.md), [GitHub workflows](docs/GITHUB.md), [Security](docs/SECURITY.md), [Deployment](docs/DEPLOYMENT.md), and [Testing](docs/TESTING.md).

## Current limitations

- Custom cookie-authenticated mutation routes require exact configured browser origin, `Sec-Fetch-Site: same-origin`, and route-appropriate content types. Configure `BETTER_AUTH_URL` to the exact public origin.
- No provider credential was available in the build environment, so live model inference remains unverified. Adapter behavior is covered by controlled wire-schema, pagination, streaming-limit, and failure fixtures.
- xAI, DeepSeek, Mistral, OpenRouter, and Ollama use strict OpenAI-compatible chat profiles. Provider-native features outside that surface are not exposed yet.
- Agent external-data tools are limited to `web_fetch`, `github_repository_read`, and `artifact_text_read`. Internal `agent_message_send` and `delegate_task` affect only bounded orchestration state. There is no shell, browser automation, code execution, infrastructure, or model-accessible GitHub write tool.
- Research synthesis is limited to bounded stored excerpts. The overlap check is intentionally conservative lexical evidence, not semantic entailment or independent fact checking. Unsupported claims remain visible and flagged.
- SQLite supports one writing application replica. PostgreSQL is required before horizontal workers or multi-region operation.
- GitHub App OAuth/install flow and webhook reconciliation are not implemented. Users may connect an appropriately scoped token; short-lived installation tokens are recommended.
- Provider prices are not fabricated. Operators can attach documented per-model pricing evidence in Model Gateway. Monetary budgets block priced execution when the selected model still has no documented price. Provider invoices remain authoritative when network outcomes are ambiguous.
- Run/agent resource scopes are enforced by backend runtime controls; the current budget UI creates owner, owned-project, and owned-provider policies. See `docs/COSTS.md` for exact partition and reservation semantics.
- Audio, image generation, embeddings, and model image ingestion are not implemented. Provider contracts map image URLs only on explicitly supported surfaces, but browser/agent flows do not accept them because the built-in scanner cannot promote images. Clean UTF-8 text and JSON artifacts are available only through the owner-scoped read tool.
- Project memory accepts only explicit owner-authored instructions and decisions. Active records are injected with provenance labels and character caps; retrieved/model claims are never auto-promoted.
- Whole-account deletion removes local data and credential ciphertext but cannot revoke provider API keys or GitHub tokens at their issuer. Export and remote revocation are explicit pre-deletion steps. A replacement owner requires the operator to restore `NEXUS_BOOTSTRAP_TOKEN` after deletion completes.

## License

No project license has been selected. All third-party dependencies retain their own licenses. Do not redistribute this repository as open source until an explicit license is added.
