# Security and threat model

## Protected assets

User sessions, provider credentials, GitHub tokens, private project data, prompts, model output, source records, artifacts, budgets, audit history, and authority to perform external writes.

## Trust boundaries

- Browser input is untrusted and validated with Zod at API boundaries.
- Retrieved web, feed, social, GitHub, model, and tool content is data, never authorization or trusted memory.
- Project memory can contain only explicit owner-created instructions or decisions; schema constraints fix provenance to `explicit_user` and trust to `trusted_user`.
- Sessions and ownership checks are enforced server-side.
- Secret handles are resolved only inside server modules.
- Models can request only fixed broker tools. External operations are read-only; internal messaging/delegation effects require explicit stored and snapshotted allowlists plus `read_only_or_internal` policy. Model output and collaboration text never grant authority or select arbitrary implementations.

## Implemented controls

### Authentication and authorization

Better Auth supplies scrypt password hashing, database sessions, secure cookies in production, session expiry/refresh, and auth rate limiting. Registration requires `NEXUS_BOOTSTRAP_TOKEN`; a database trigger atomically permits exactly one owner account. Every application query derives `user_id` from the authenticated session.

### Secrets

Provider and GitHub credentials use AES-256-GCM with a fresh 96-bit nonce. `NEXUS_MASTER_KEY` must decode to 32 bytes and is required in production. Credentials are not returned by status endpoints, written to audit metadata, or included in model context. Readiness verifies an encryption round trip without persisting the probe.

Back up the master key separately from the database. Losing it makes stored credentials unrecoverable. Rotate credentials before replacing the master key; envelope key identifiers and online re-encryption are not implemented yet.

### Prompt injection

Research content is tagged `untrusted_external`. The agent broker exposes three fixed read-only operations and two fixed internal orchestration operations. Every call validates stored and snapshotted allowlists, policy mode, owner/run/task/attempt authority, counts, deadlines, cancellation, and exact JSON arguments. Read results are bounded, redacted, and labeled untrusted. Internal results contain only task/message IDs and cannot write outside the orchestration database.

Agent messages use `untrusted_agent`; owner messages use `explicit_user`. Both remain coordination data, never system instructions, trusted memory, or permission grants. Recipient membership and active task targeting are server-derived. Reply direction/correlation, four-hop depth, 8,000-byte bodies, run/inbox counts, expiry, and idempotency are enforced. Delegation snapshots the recipient policy and inherits only the parent's model target. It cannot copy authority from message text. Synthesis preserves material disagreement rather than treating collaboration as consensus.

Shell, browser automation, code execution, infrastructure operations, and model-accessible GitHub writes remain absent. GitHub writes use separate authenticated routes with exact schemas and confirmation. Instructions found in webpages, repositories, artifacts, messages, or task output cannot alter connection or broker policy.

### SSRF and untrusted retrieval

Research accepts HTTP(S) only, rejects URL credentials and non-standard ports, permits only globally routable IPv4 destinations in the beta, resolves all addresses before dispatch, and pins the permitted addresses in the HTTP agent. Native IPv6 retrieval is denied until an automatically maintained IANA reachability policy is available. Redirects are revalidated and cross-origin authorization headers are removed. Responses have time and two-mebibyte limits. HTML scripts, styles, forms, frames, and active elements are removed. XML entities are disabled.

Owner, caller, and fixed provider/network deadline signals are composed at every GitHub, retrieval, and model outbound boundary. Owner deletion aborts registered operations without removing the existing 15-second research, 20-second GitHub, or 60-second synthesis deadlines.

A production deployment should still enforce outbound destinations at the network layer. Application validation cannot replace an egress proxy or firewall.

### External writes

GitHub issue, branch, file-change, and draft pull-request routes require `confirm: true` and a UUID idempotency key. Each key is bound to the canonical exact payload; reuse with changed repository, ref, path, content, SHA, title, or body returns a conflict. Issue creation preserves its original ledger/hash format and hidden marker for compatibility. Branch, file-change, and draft-PR operations use the durable `github_write_operations` state machine.

Branch creation resolves an explicit base SHA, rejects the repository's current default branch, refuses an existing target, and only creates a ref. It never patches or force-updates a ref. File changes accept one validated relative path and at most 256 KiB of valid UTF-8, resolve the target branch to a commit, compare the current blob SHA with the confirmed preview SHA, and call GitHub's Contents API with that expected SHA. A deterministic operation marker is included in the commit message. Draft PR creation binds exact head, base, title, body, and draft state; it never merges.

Each `prepared` GitHub intent is claimed with one conditional `prepared -> pending` update. Only the winner may issue POST/PUT. Followers wait briefly and reconcile exact remote state or return an in-progress/unknown result; they never repost. State transitions are conditional and monotonic, and no failure path can move a `completed` row back to a nonterminal state. A timeout or 5xx after a write moves only a pending operation to reconciliation. Branch recovery requires the exact intended SHA. File recovery reads the branch tip, file content, and commit marker. PR recovery requires the exact marker, head, base, title, body, and draft state across all PR states. If those checks cannot prove the outcome, NEXUS fails closed and does not repost. Completed responses replay before credential lookup. Repository content remains untrusted data and is never executed or promoted to memory.

### Artifact storage and uploads

Authenticated raw-body uploads are streamed to a mode-0600 temporary file and stopped at 10 MiB, regardless of `Content-Length`. Filenames are normalized for display and never determine filesystem paths. The server computes SHA-256 and stores content under `NEXUS_ARTIFACT_ROOT/sha256/<prefix>/<digest>`. A logical per-owner quota is enforced by `NEXUS_ARTIFACT_QUOTA_BYTES`.

The scanner boundary is an interface. The built-in scanner fails closed and marks only valid UTF-8 plain text and JSON clean. Executable, script, archive, mismatched declared MIME, image, and unknown binary inputs are rejected unless an operator supplies a separate scanner implementation. Other scanner implementations may leave content quarantined; quarantined content cannot use the normal download route. Downloads repeat owner checks and set `Content-Disposition: attachment`, `nosniff`, and `no-store`. Deletion serializes blob mutations and removes bytes only after no artifact or attachment metadata row references the content path. Uploads are storage-only except for `artifact_text_read`, which uses the owner-scoped download gate and accepts only clean UTF-8 text/JSON with a smaller tool-result cap. It never exposes `storage_path`. No parser, extractor, preview renderer, image input, or executable path consumes uploads.

### Memory trust

`project_memories` permits only `instruction` and `decision` records explicitly submitted through the authenticated memory API. The database fixes their trust and provenance values. Active memories are injected into chat and agent system context with provenance labels and a 12,000-character cap. Retrieved, model-generated, research, GitHub, artifact, and tool content remains in untrusted records and has no automatic promotion path. Time-limited records are excluded by the context query and physically deleted, with an audit record that omits content, on the next memory read or owner export after expiry.

### Data lifecycle

The owner export streams a field-whitelisted JSON manifest and omits encrypted credentials and artifact filesystem paths. Provider and GitHub disconnects delete local ciphertext and mark the connection disconnected. They do not claim issuer-side revocation because generic provider keys have no common revocation API and GitHub personal-token revocation requires an issuer-specific application credential flow not configured here.

Account deletion requires an authenticated current-password check through Better Auth, the exact phrase `DELETE MY NEXUS ACCOUNT`, and a stable idempotency key. Migrations `0009_account_deletion.sql` and `0010_security_reliability_boundaries.sql` store a credential-free job plus durable owner runtime state. Deletion atomically sets the owner to `quiescing`; all chat, research, agent, tool, delegation, provider-validation, and new-integration admissions fail closed. It cancels durable work, aborts registered model operations, conservatively accounts dispatched usage, and waits boundedly for operations and leases to drain before deleting files, credentials, and the user. Startup reconciles crash-left quiescing jobs. Failure restores active admission only when the owner remains and no operation or lease remains; otherwise quiescence is retained for recovery. Only after every byte is absent does one SQLite transaction redact retained owner audit metadata, cascade-delete the owner and authentication/workspace rows, verify foreign keys, and retain a non-secret completed tombstone.

Completed deletion does not revoke provider keys or GitHub tokens remotely. The Settings flow therefore recommends export and issuer-side revocation first. The single-owner trigger permits a replacement owner after full deletion, but the operator must restore `NEXUS_BOOTSTRAP_TOKEN` and restart before signup.

### Web application

React escapes displayed model, source, GitHub, and user text. Every custom unsafe API route passes through the shared session mutation guard. Browser requests require `Origin` to equal the configured `BETTER_AUTH_URL` origin and `Sec-Fetch-Site: same-origin`; `same-site` and `cross-site` are rejected. JSON mutations require `application/json`, including charset parameters. Raw artifact upload has an explicit narrow media-type allowlist. Non-browser clients are trusted only when both Origin and Fetch Metadata are absent, and they still require a valid session and allowed content type. Operators must configure the exact external origin rather than deriving it from `Host`. Security headers include MIME sniffing protection, frame denial, referrer policy, permissions policy, and a CSP restricting origins, frames, objects, forms, and connections. The static CSP currently allows inline script/style because Next.js bootstrap and local styling require them; nonce-based CSP is a future hardening step.

### Cost and agent exhaustion

Runs cap selected agents, targets, parallelism, tasks, depth, attempts, duration, turns, tool calls, messages, delegations, hops, inbox size, and message lifetime. Monetary and resource policy checks plus reservations occur in SQLite transactions before model, tool, or task work. `model_calls` is consumed when adapter dispatch begins. Each terminal provider turn settles immediately before subsequent tools or local validation. Only work proven not dispatched is released; cancellation, deadlines, lease recovery, stream failure, and expiry after dispatch retain conservative tokens and estimated cost with an unknown outcome. See `docs/COSTS.md` for exact settlement semantics.

### Backup boundary

The operator backup command produces an authenticated version-2 bundle. A dedicated `NEXUS_BACKUP_SIGNING_KEY` (base64, at least 32 decoded bytes) HMAC-authenticates the exact manifest bytes with SHA-256 and is never written into the bundle. Verification compares the MAC in constant time before parsing or trusting manifest fields, then verifies database/artifact checksums, migrations, counts, and credential envelopes. The bundle is not encrypted. Storage encryption and separate custody of the signing and credential-encryption keys remain operator responsibilities.

## Threat summary

| Threat | Current mitigation | Remaining risk |
|---|---|---|
| Credential theft | Server-only AES-GCM, redacted audit, secure sessions | Host compromise or lost master key; use managed secrets for higher assurance. |
| Cross-user access | Session-derived ownership predicates | Add property-based cross-tenant tests before multi-tenant hosting. |
| Prompt injection | Trusted-memory separation plus a fixed read-only/internal broker with stored and snapshotted allowlists, schemas, owner authority, limits, redaction, and untrusted message/result labels | Read tools and collaborators can still return adversarial text; no model-accessible external write or execution tool is exposed. |
| SSRF | Public-address checks, DNS pinning, redirects, limits | Add network egress enforcement and DNS rebinding integration tests. |
| Malicious repository | Read as data; no automatic script execution | Sandboxed code execution is not implemented. |
| GitHub duplicate writes | Payload-bound durable intents; exact SHA/marker reconciliation; fail-closed ambiguous outcomes | GitHub API consistency and unavailable credentials can delay reconciliation; no live write smoke was performed. |
| Cost exhaustion | Transactional monetary/resource reservations, model/token/tool/task ceilings, shared run and snapshotted agent caps, deadlines | Provider billing can remain ambiguous after network failure; reconcile invoices. |
| XSS | React text rendering and CSP | Inline CSP allowance should be replaced by per-request nonces. |
| SQL injection | Prepared statements | Continue prohibiting dynamic user-controlled SQL fragments. |
| Worker crash | Leases, fencing token, attempt history, recovery | Provider calls can have ambiguous billed outcomes. |
| Dependency compromise | Lockfile, pinned CI actions, audit gate | Add automated update review and SBOM/signing. |
| Webhook forgery | Webhooks not implemented | Verify raw-body HMAC and delivery IDs before adding them. |
| File upload, deletion, and backup path attacks | 10 MiB streamed upload limit, server MIME detection, narrow inert allowlist, quota, content-addressed paths, shared mutation lock, strict deletion inventory, regular-file/symlink escape rejection, no-follow backup copies, hashes, attachment-aware cleanup | Add a maintained malware engine before broadening the allowlist; document extraction remains disabled. |

## Reporting and operations

Audit events record security-relevant actions without credentials. Do not log request headers wholesale. Review failed connection checks, denied writes, repeated retries, and budget events. See `semantic-review/` for the independent implementation review and `docs/TESTING.md` for observed verification.
