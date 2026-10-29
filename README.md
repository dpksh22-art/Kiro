# NEXUS AI OS

NEXUS is a self-hosted, multi-model AI workspace with encrypted provider connections, direct streaming inference, side-by-side model comparison, persisted agent teams, evidence-backed research, GitHub REST integration, usage records, and backend-enforced budgets.

This repository contains a functioning single-node application. It does not include model API entitlements, paid search access, or a hosted production environment.

## Implemented

- Better Auth email/password sessions and protected application/API routes.
- Owner bootstrap token and a database-enforced single owner account.
- AES-256-GCM server-side encryption for provider and GitHub credentials.
- Provider adapters for OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Mistral, OpenRouter, and Ollama.
- Live model discovery. Unknown capabilities, context limits, and prices remain unknown.
- Single-model and parallel-model streaming chat with independent status and failure handling.
- Durable projects, conversations, messages, usage, artifacts, audit events, and task runs.
- Fourteen built-in agent templates plus UI-created custom agents.
- Persisted task DAGs, bounded parallel claims, leases, retries, deadlines, cancellation, crash recovery, events, and final synthesis.
- Research connectors for direct webpages, RSS/Atom, Hacker News, public GitHub repositories, and optional Tavily discovery.
- SSRF controls, DNS pinning, redirect revalidation, active-content removal, size limits, source hashes, and citation records.
- GitHub repository/branch/issue/PR/Actions reads and confirmed branch/issue/PR writes through official REST APIs.
- Transactional usage reservations and monetary budget admission. Unknown prices fail closed when a monetary limit applies.
- Responsive dark/light workstation interface with honest empty, disconnected, running, failed, and cancelled states.
- SQLite WAL single-writer deployment, reviewed migration, health checks, Docker/Compose, CI, and automated tests.

## Quick start

Requirements: Node.js 22.13 or later and npm.

```bash
npm ci
cp .env.example .env
```

Generate three independent secrets:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # NEXUS_MASTER_KEY
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
3. Select **Validate**. NEXUS calls the provider's model-list endpoint and stores the returned identifiers.
4. Open **Unified Chat** and select one discovered model, or select two to four models for parallel comparison.

Ollama uses `OLLAMA_BASE_URL` and does not require an API key. The endpoint is configured by the server operator, not supplied by browser input.

### Run an agent team

Open **Agent Teams**, select agents and models, enter a goal, and start a run. Independent tasks execute concurrently. A synthesis task remains blocked until dependencies terminate. Refreshing or closing the browser does not remove task state. The embedded worker resumes eligible database work after application restart.

### Research

Open **Research Lab** and use a public webpage, RSS/Atom URL, Hacker News item ID, or `owner/repository`. Tavily search appears in the UI but returns a configuration error until `TAVILY_API_KEY` is set. Reddit and X are intentionally unavailable without approved API access.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start local development. |
| `npm run db:migrate` | Apply Better Auth and NEXUS migrations. |
| `npm run lint` | Run ESLint. |
| `npm run typecheck` | Run strict TypeScript checks. |
| `npm test` | Run deterministic unit and database integration tests. |
| `npm run test:e2e` | Run Playwright authentication, authorization, and live public-web research flows. |
| `npm run build` | Build the production application. |
| `npm run start:production` | Apply migrations and start the supported standalone server entrypoint. |
| `npm run check` | Run lint, typecheck, unit/integration tests, and build. |

## Architecture

NEXUS is a modular monolith on Next.js 16 and Node.js 22. SQLite is the initial durable system of record for a personal single-node deployment. The provider gateway, task runtime, research connectors, and GitHub integration have owned interfaces and tables. External effects are at-least-once; the application uses idempotency keys where an API permits reconciliation.

See [Architecture](docs/ARCHITECTURE.md), [Providers](docs/PROVIDERS.md), [Agents](docs/AGENTS.md), [Security](docs/SECURITY.md), [Deployment](docs/DEPLOYMENT.md), and [Testing](docs/TESTING.md).

## Current limitations

- No provider credential was available in the build environment, so live model inference remains unverified. Adapter behavior is covered by controlled mocks.
- xAI, DeepSeek, Mistral, OpenRouter, and Ollama use strict OpenAI-compatible chat profiles. Provider-native features outside that surface are not exposed yet.
- Tool-calling schemas exist in the architecture but the first agent runtime is model-only. It does not execute model-proposed shell, browser, or repository actions.
- Research reports are extractive evidence packets. Agent-assisted evidence synthesis is separate and does not yet call research connectors from within the model loop.
- SQLite supports one writing application replica. PostgreSQL is required before horizontal workers or multi-region operation.
- GitHub App OAuth/install flow and webhook reconciliation are not implemented. Users may connect an appropriately scoped token; short-lived installation tokens are recommended.
- Provider prices are not fabricated. Operators can attach documented per-model pricing evidence in Model Gateway. Monetary budgets block priced execution when the selected model still has no documented price.
- Audio, image generation, embeddings, and attachment ingestion are represented in the registry but not implemented in the first UI.

## License

No project license has been selected. All third-party dependencies retain their own licenses. Do not redistribute this repository as open source until an explicit license is added.
