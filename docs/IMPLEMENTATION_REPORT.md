# Implementation report

Date: 2026-10-30
Repository: `dpksh22-art/Kiro`
Branch: `feat/nexus-completion`
Release boundary: single-owner, single-node, self-hostable beta candidate; live-provider, remote-deployment, and observed-container release gates remain open

## Built

A Next.js application implemented within the listed beta scope, with Better Auth, encrypted provider/GitHub connections, provider-independent streaming inference, on-demand model discovery snapshots, parallel responses, projects and conversation persistence, a fourteen-template agent factory, durable task DAG execution, evidence retrieval with citations, GitHub REST workflows, monetary and resource accounting, backend budget enforcement, coordinated backup/restore verification, safe whole-account deletion, audit history, responsive UI, migrations, CI, and deployment configuration.

## Architecture

- Next.js 16.4.3, React 19.3.1, TypeScript 5.9.3.
- Better Auth 1.7.14 with SQLite-backed sessions and scrypt passwords.
- SQLite 13 in WAL mode for one writing application process.
- Direct HTTP adapters rather than an additional LiteLLM service.
- Database-backed tasks, attempts, dependencies, events, leases, fencing, deadlines, retry, cancellation, and recovery.
- SSE for interactive model streams and durable cursor-based run events.
- AES-256-GCM credential envelopes.
- Undici pinned-address research egress, limited to globally routable IPv4 in the beta.

## Providers

Implemented adapters/profiles: OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Mistral, OpenRouter, and Ollama. No model-provider credentials were available, so none was live-tested. OpenAI-compatible, Anthropic, and Gemini behavior and failures were tested with controlled mock streams. Anthropic and Gemini still require live conformance promotion before production use.

## Multi-agent execution

Verified. An integration run assigned two independent tasks, observed concurrent model calls, persisted each output and event, unblocked synthesis only after dependencies terminated, settled three usage reservations atomically, and reached `succeeded`. Deadline and worker-loss cancellation paths have separate regression tests.

## Research

Implemented direct webpage, RSS/Atom, Hacker News, public GitHub repository, and optional Tavily connectors. Retrieval persists independently before optional model synthesis. Migration `0007_evidence_aware_research.sql` records report status, selected model provenance, bounded untrusted evidence packets, normalized report-source membership, synthesis, per-claim verification, sanitized failure state, and linked usage. Strict Ajv validation plus application checks reject malformed output, unknown source IDs, and invented URLs; duplicate citations are normalized and weak excerpt overlap remains visible as unsupported. The browser supports up to ten complementary source requests and evidence-only or discovered-model mode. Reddit and X connectors are not implemented and require platform API approval and compliance work; credentials alone are insufficient. Native IPv6 retrieval remains intentionally denied in the beta; dual-stack domains use pinned permitted IPv4 answers.

## GitHub

Outside the application, the connected sandbox credential verified repository metadata, branches, issues, pull requests, Actions, search, and effective admin role. Sensitive webhook/secrets endpoints were denied. In the application, official REST reads now include explicit-ref UTF-8 file snapshots plus tree/compare service operations. Confirmed writes include legacy-compatible issue creation, idempotent non-force branch creation, one-file Contents API changes with expected-blob-SHA compare-and-swap, and exact draft PR creation. Migration `0004_github_write_operations.sql` persists payload hashes, operation state, target metadata, remote IDs, file/commit SHAs, and replay results. Ambiguous branch, file, and PR outcomes reconcile exact remote state or fail closed without reposting. No application write smoke test was performed because it would create external state.

## Verification

- Clean migrations: passed on a new production-configured database through `0010_security_reliability_boundaries.sql`; no transient schema mismatch diagnostic was emitted.
- ESLint and strict TypeScript: passed.
- Unit/integration: 154 tests passed in 28 files, including provider wire-schema restrictions, bounded pagination and stream accumulation, dispatch-aware budget settlement/recovery, synchronized GitHub claims, coordinated backup tampering, owner quiescence/drain, CSRF/content-type policy, evidence packet bytes, and runtime packaging.
- Chromium E2E: 5 tests passed, including artifact upload and bodyless same-origin deletion through the mutation guard.
- Standalone production smoke: 1 test passed with readiness at `0010_security_reliability_boundaries.sql`, writable data stores, credential encryption, backup authentication, and unauthenticated redirect behavior.
- Standalone persistent restart: passed with the latest schema and one retained marker row.
- Authenticated backup/isolated verify: representative fixture, wrong/missing signing key, coordinated database+manifest+checksum tamper, artifact tamper, credential-key mismatch, path overlap, and symlink cases passed.
- Next.js production build: passed; 39 static-generation work items completed.
- Full lockfile audit and production-only audit: 0 known vulnerabilities.
- Final independent semantic review: `semantic-review/2026-10-30-025950-pr-1.md` returned `APPROVED` with zero issues and no critical/high blockers.
- Container image build/run: not locally available in this sandbox. CI builds the image, audits its installed production tree, and checks readiness plus named-volume restart persistence; the static runtime-packaging test passed locally.

## Deployment

No external development or staging target was available, so no remote deployment occurred. `Dockerfile`, `compose.yaml`, health checks, absolute production data path enforcement, non-root runtime, persistent volume, online backup creation, isolated restore verification, upgrade, and rollback guidance are included. Container restart evidence awaits an actual CI workflow run.

## Configuration required

- `BETTER_AUTH_URL`
- `BETTER_AUTH_SECRET`
- `NEXUS_MASTER_KEY`
- `NEXUS_BACKUP_SIGNING_KEY` (independent base64 32+ byte key, stored outside bundles)
- Absolute `NEXUS_DATABASE_PATH` in production
- Absolute `NEXUS_ARTIFACT_ROOT` in production and optional `NEXUS_ARTIFACT_QUOTA_BYTES`
- `NEXUS_BOOTSTRAP_TOKEN` for initial owner creation
- At least one provider API key or reachable operator-configured Ollama endpoint
- Optional `TAVILY_API_KEY`
- Optional appropriately scoped GitHub App installation token or fine-grained token

## Security and cost controls

The database atomically enforces one owner. Routes derive ownership from sessions. Secrets stay server-side and encrypted. Research content is untrusted, size-limited, stripped of active markup, protected against DNS rebinding, and restricted to globally routable IPv4. Provider streams fail on in-band errors or missing terminal markers. Agent work is bounded by count, depth, parallelism, attempts, per-agent duration, run deadline, and cancellation. Monetary budgets reserve documented USD cost. Resource policies reserve model calls, estimated input, maximum output, broker calls, and task starts across owner/project/provider/run/agent scopes. Stored agent caps are snapshotted per run, and delegated work shares run quota. Actual terminal provider usage settles immediately. A model call is consumed at dispatch; post-dispatch failure, cancellation, deadline, lease loss, or recovery retains conservative usage with an unknown outcome. Only work proven not dispatched is released.

## Known limitations

- No live provider inference or provider-reported billing reconciliation was possible.
- Tool calling exposes three deterministic read-only data tools plus bounded internal `agent_message_send` and `delegate_task` effects. No shell, browser, code-execution, infrastructure, external-write, or model-accessible GitHub write tool is available. Image input, audio/image generation, and embeddings remain unavailable.
- Collaboration delivery is at-most-once into an attempt context after transactional acknowledgement; a process failure after acknowledgement but before provider completion can leave the retry without that inbox item. Provider requests remain at least once.
- GitHub App OAuth/install and webhook flows are not implemented.
- Research synthesis is bounded to stored excerpts. Lexical overlap verification is conservative support evidence, not semantic entailment or independent fact checking.
- One SQLite writer only; PostgreSQL is required for horizontal workers.
- IPv6-only research origins are unavailable.
- Container execution was not verifiable in this sandbox.

## Next priorities

1. Live-promote OpenAI, Anthropic, or Gemini with a credentialed conformance suite.
2. Obtain an observed CI result for the container build/readiness/persistent-volume restart job.
3. Run an operator-controlled offline restore cutover drill on a staging host with encrypted backup storage.
4. Expand research verification beyond conservative lexical overlap only if an independently testable entailment method is introduced.
5. Implement GitHub App installation OAuth, short-lived token refresh, and signed webhooks.
6. Add a maintained malware engine and isolated document extraction before broadening upload types.
7. Move to PostgreSQL and separate workers when the single-node scale trigger is reached.

## Credential-independent data lifecycle increment

Migration `0003_artifact_memory_lifecycle.sql` adds project-scoped memory with fixed explicit-user provenance and trusted-user classification, retention metadata, artifact upload/scan state, artifact lifecycle indexes, and a repaired attachment-to-artifact foreign key. Existing orphan attachment references are set to null during the migration; artifact deletion sets linked attachment references to null.

Artifacts now use authenticated raw-body streaming with a hard 10 MiB limit, normalized display filenames, server-side MIME detection, SHA-256 content addressing under `NEXUS_ARTIFACT_ROOT`, a configurable per-owner quota, scanner/quarantine states, owner-scoped metadata/download/delete APIs, download hardening headers, audit events, and reference-aware physical cleanup. The built-in scanner marks only UTF-8 text and valid JSON clean. It rejects executables, scripts, archives, MIME mismatches, images, and unknown binary files unless an operator supplies a separate scanner implementation. Clean text/JSON may be read by the bounded owner-scoped `artifact_text_read` broker tool; no filesystem path, binary parser, or extractor reaches the model.

Project memory CRUD accepts only owner-authored `instruction` and `decision` records. Database checks fix `trust_level=trusted_user` and `provenance=explicit_user`; external retrieval and model claims remain in untrusted source/output records and have no automatic promotion path. Active records now enter chat and agent system context with provenance labels and a 12,000-character cap; expired rows are excluded.

The owner can stream a field-whitelisted JSON manifest covering projects, conversations, messages, agents, runs, events, research, memory, and artifact metadata. Encrypted provider/GitHub values and artifact filesystem paths are omitted. Provider and GitHub disconnect routes delete local ciphertext and mark connections disconnected. Generic provider keys and GitHub personal tokens cannot be universally revoked at the issuer by this application, so responses and UI report local deletion without claiming remote revocation.

Project, conversation, memory, and artifact deletions enforce owner predicates and write audits. Project deletion cascades conversations and memory; schema-defined historical run/artifact links become null. Content-addressed bytes are removed only after the final artifact metadata reference is deleted.

Whole-account deletion is now available through a custom authenticated route rather than Better Auth's stock delete endpoint. Migration `0009_account_deletion.sql` keeps idempotent job and progress state outside user cascades using only a one-way owner ID hash, request hash, counts, sanitized error, and timestamps. Better Auth's server API verifies the current password; the route also requires `DELETE MY NEXUS ACCOUNT`, a UUID idempotency key, and never accepts a user ID.

The artifact service inventories unique artifact and attachment paths and performs cleanup under its existing upload/delete/backup lock. Strict content-address validation, regular-file checks, resolved-parent containment, and foreign-reference checks reject malformed or symlink-escaped paths. Each unlink is idempotent and progress is durable. Failure retains the user and a retryable job. Once all bytes are absent, one SQLite transaction removes immediate-RESTRICT join rows, deletes owner-linked verification records, redacts retained audit metadata, writes `account.deleted`, deletes the user so account/session and owner roots cascade, runs `foreign_key_check`, completes the job, and removes path details. The tombstone and final owner-null audit retain only counts and timestamps. The single-owner trigger permits a new owner only after completion; operator restoration of the bootstrap token is required.

The Settings UI recommends the existing export, distinguishes local ciphertext deletion from remote issuer revocation, requires password plus exact phrase, preserves one browser idempotency key through retries, and reaches `/goodbye` only for a completed response. The shared browser owner is protected by mocking only this destructive response in E2E.

The migration entrypoint now creates a migration-only auth instance without importing the runtime singleton. Better Auth schema validation is disabled only for that instance, avoiding a pristine-schema diagnostic while normal production request initialization retains validation. A production-environment subprocess regression test asserts a clean migration through `0009` has no schema mismatch error output.

## Credential-independent gateway and tool-loop increment

Migration `0005_gateway_tool_loop.sql` extends the existing invocation ledger with attempt linkage, provider call IDs, canonical argument fingerprints, update timestamps, truncation state, and indexes. The canonical gateway now represents string-compatible multipart content, image URLs on explicitly supported surfaces, unresolved artifact references, tool declarations/calls/results and choice, strict JSON Schema response formats, canonical partial/completed tool calls, and parsed structured output.

OpenAI-compatible Chat Completions, native Anthropic Messages, and native Gemini GenerateContent map tools, tool history, provider choices, and structured-output controls. Controlled tests cover request bodies and partial tool streams. Unsupported provider shapes and unresolved artifact references fail rather than being dropped. Image mappings exist for OpenAI-compatible and Anthropic requests, but no browser or agent API can supply arbitrary image URLs. The built-in scanner still promotes only text/JSON, so image model input remains gated.

The new broker exposes only `web_fetch`, `github_repository_read`, and `artifact_text_read`. It reuses the existing safe research connector, read-only GitHub overview, and clean owner-scoped artifact download boundary without changing their internals. It validates fixed schemas, stored allowlists, read-only policy, owner/run/task/attempt state, maximum calls, deadlines, and cancellation. Results are redacted, bounded, labeled untrusted, and audited through durable invocation state plus `ToolRequested`/`ToolCompleted`. There is no shell, browser automation, code execution, GitHub write, or infrastructure tool.

Agent roots now use stored maximum turns and per-agent duration in a bounded model/tool loop. Each provider turn receives a usage reservation. Successful lease-fenced completion settles each reservation and persists final text, optional structured output, aggregate usage, and a human-readable trace. Empty responses, repeated canonical tool fingerprints, turn exhaustion, tool-call exhaustion, deadlines, cancellation, and lost authority stop execution. Root/synthesis DAG ordering is unchanged; synthesis remains one model-only turn.

Chat and agents inject only active explicit `trusted_user`/`explicit_user` project memories, with provenance labels and a 12,000-character cap. Chat replays at most 24 completed messages and 24,000 characters before the current prompt. Research, provider, repository, artifact, and tool output is never promoted to trusted memory.

Custom-agent API and UI fields now configure the broker allowlist, maximum turns, maximum tool calls, duration, read-only policy, and optional object-root JSON Schema under server-enforced limits. Built-in templates now reference actual broker names or no tool. Ajv validates requested schemas locally under fixed byte, depth, node, property, enum, combinator, and keyword limits. Every `structured_output.completed` value is checked against the exact schema again before persistence, without coercion, defaults, or property removal.

Remaining limits are unchanged: no live provider credential was available; image input remains gated pending scanner promotion; only a conservative shared JSON Schema subset is accepted; only one SQLite writer is supported; no effectful model tool exists.

## Durable messaging and internal delegation increment

Migration `0006_agent_messaging_delegation.sql` turns `agent_messages` into active durable state with sender/recipient task and attempt links, pending/delivered/acknowledged/expired state, explicit trust labels, idempotency keys, expiry and delivery timestamps, recipient/correlation indexes, and model/human dedupe indexes. `run_agent_participants` stores initial and delegated membership with agent policy snapshots. `task_delegations` binds each parent/child, recipient, assignment message, fingerprint, idempotency key, and correlation.

The owner-scoped collaboration service validates the active run, deadline, sender attempt, recipient membership and active task, reply direction/correlation, hop count, UTF-8 byte size, expiry, and run message count. Human messages are `explicit_user`; agent messages are `untrusted_agent`. Both are explicitly presented as coordination data, never trusted memory, system instructions, or permission grants. Before each model turn the runtime appends pending messages addressed to that exact task/agent and then transactionally acknowledges exactly those IDs.

The fixed broker adds `agent_message_send` and `delegate_task` under `internal_orchestration` invocation scope. Both require the stored and task-snapshotted allowlist plus `read_only_or_internal` policy and per-attempt limits. Delegation atomically validates task/depth/deadline/cancellation constraints, snapshots the recipient's stored instructions/policy/budget/turn/duration/schema, inherits only the parent model target, creates a ready child, introduces the recipient participant, persists an assignment message, and adds the child as a terminal dependency of blocked synthesis. Duplicate fingerprints or idempotency keys return the existing IDs and cannot create recursive unbounded work.

The run snapshot/API/UI now show parent-child tasks, participants, messages, correlation/replies, trust and delivery state, and durable events. The owner can send a bounded message to an active participant from the run page. Synthesis receives every persisted participating task output and each unexpired material message, with instructions to preserve disagreement. Cancellation covers dynamically inserted tasks and expires pending messages; delegation after cancellation or deadline fails.

Observed verification after the research increment was superseded by the dated results near the top of this report. The current run covers migrations through `0009`, 121 unit/integration tests, five Chromium browser tests including the mocked destructive Settings flow, the production build, standalone readiness, persistent restart, and backup/restore evidence. Mock providers verify internal collaboration plus research synthesis behavior. No external write or live model call was performed.

## Resource-budget and recovery-evidence increment

Migration `0008_resource_budgets.sql` adds normalized policies for `model_calls`, `input_tokens`, `output_tokens`, `tool_calls`, and `task_starts`. Policy scopes are owner, project, provider, run, or agent; periods are task, run, UTC day, or UTC month. The linked ledger records reserved, consumed, and released units with usage/model, tool-invocation, run/agent/task/attempt, message, and research-report attribution. All matching ceilings apply independently.

Chat, every agent provider turn, and research synthesis reserve one model call, estimated input, and requested maximum output before dispatch. `model_calls` becomes consumed at adapter dispatch. Terminal responses settle immediately before later tools or local validation. Post-dispatch cancellation, failure, deadline, lease recovery, and expiry retain conservative usage as unknown; only provably pre-dispatch reservations release. Task claim atomically consumes one task start; the broker reserves and consumes one tool call immediately before validated execution. `budget_exceeded` is preserved as a terminal typed task failure without retry or expensive fallback.

Custom-agent API/UI fields persist optional per-run model-call, output-token, and tool-call caps in validated `budget_json`. Initial and delegated tasks snapshot that value. Runtime aggregation keys by run and agent, while run-scoped policies aggregate every initial and delegated participant, so child creation cannot mint quota. Budget API/UI support create/list/delete for monetary and resource policies under owner and verified owned-project/provider scopes. Usage UI reports resource reserved/consumed/released separately. Command-center settled cost now excludes released reservations and renders zero as `$0.00`.

The operator backup command requires an absolute disjoint destination and creates an authenticated version-2 mode-0700 directory. It uses the installed database online-backup API, holds the artifact mutation lock, validates content-addressed paths, copies only referenced regular files, and writes a checksum plus HMAC-SHA256 over the exact manifest. `NEXUS_BACKUP_SIGNING_KEY` is separate and never stored in the bundle. The bundle is not encrypted; storage encryption remains an operator responsibility.

Restore verification accepts an absolute bundle path, rejects symlink components and malformed trees, copies into a random disposable directory, validates manifest/database/artifact hashes, runs quick/integrity/foreign-key checks, compares migration hashes and row counts, and optionally authenticates restored credential envelopes with the current master key without outputting plaintext. It always cleans its temporary path and never changes current database or artifact paths. Production replacement remains an offline operator cutover, not an in-place overwrite command.
