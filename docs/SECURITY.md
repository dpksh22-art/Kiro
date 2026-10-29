# Security and threat model

## Protected assets

User sessions, provider credentials, GitHub tokens, private project data, prompts, model output, source records, artifacts, budgets, audit history, and authority to perform external writes.

## Trust boundaries

- Browser input is untrusted and validated with Zod at API boundaries.
- Retrieved web, feed, social, GitHub, model, and tool content is data, never authorization.
- Sessions and ownership checks are enforced server-side.
- Secret handles are resolved only inside server modules.
- Agent output cannot directly execute tools.

## Implemented controls

### Authentication and authorization

Better Auth supplies scrypt password hashing, database sessions, secure cookies in production, session expiry/refresh, and auth rate limiting. Registration requires `NEXUS_BOOTSTRAP_TOKEN`; a database trigger atomically permits exactly one owner account. Every application query derives `user_id` from the authenticated session.

### Secrets

Provider and GitHub credentials use AES-256-GCM with a fresh 96-bit nonce. `NEXUS_MASTER_KEY` must decode to 32 bytes and is required in production. Credentials are not returned by status endpoints, written to audit metadata, or included in model context. Readiness verifies an encryption round trip without persisting the probe.

Back up the master key separately from the database. Losing it makes stored credentials unrecoverable. Rotate credentials before replacing the master key; envelope key identifiers and online re-encryption are not implemented yet.

### Prompt injection

Research content is tagged `untrusted_external`. Retrieval and extraction modules have no model-directed tool authority. Tool execution remains disabled in the first agent runtime. GitHub writes use separate authenticated routes with exact schemas and confirmation. Instructions found in webpages or repositories cannot alter connection policy.

### SSRF and untrusted retrieval

Research accepts HTTP(S) only, rejects URL credentials and non-standard ports, permits only globally routable IPv4 destinations in the beta, resolves all addresses before dispatch, and pins the permitted addresses in the HTTP agent. Native IPv6 retrieval is denied until an automatically maintained IANA reachability policy is available. Redirects are revalidated and cross-origin authorization headers are removed. Responses have time and two-mebibyte limits. HTML scripts, styles, forms, frames, and active elements are removed. XML entities are disabled.

A production deployment should still enforce outbound destinations at the network layer. Application validation cannot replace an egress proxy or firewall.

### External writes

GitHub issue, branch, and pull-request routes require `confirm: true`. Issue creation additionally binds a UUID idempotency key to the exact user, repository, title, and body. A hidden operation marker supports reconciliation after an ambiguous response. Default-branch names cannot be created by the branch endpoint. GitHub branch protection remains the final authority.

### Web application

React escapes displayed model, source, GitHub, and user text. Security headers include MIME sniffing protection, frame denial, referrer policy, permissions policy, and a CSP restricting origins, frames, objects, forms, and connections. The static CSP currently allows inline script/style because Next.js bootstrap and local styling require them; nonce-based CSP is a future hardening step.

### Cost and agent exhaustion

Runs cap selected agents, targets, parallelism, tasks, depth, attempts, and duration. Monetary policy checks and usage reservation occur in a database transaction. Unknown model price cannot pass a hard monetary budget. Cancellation and lease recovery prevent stranded active tasks.

## Threat summary

| Threat | Current mitigation | Remaining risk |
|---|---|---|
| Credential theft | Server-only AES-GCM, redacted audit, secure sessions | Host compromise or lost master key; use managed secrets for higher assurance. |
| Cross-user access | Session-derived ownership predicates | Add property-based cross-tenant tests before multi-tenant hosting. |
| Prompt injection | Untrusted-content separation; no model-controlled tools | Tool calling needs a deterministic broker and approval intents before activation. |
| SSRF | Public-address checks, DNS pinning, redirects, limits | Add network egress enforcement and DNS rebinding integration tests. |
| Malicious repository | Read as data; no automatic script execution | Sandboxed code execution is not implemented. |
| GitHub duplicate writes | Issue idempotency ledger and marker | Branch/PR operations need the same durable intent model. |
| Cost exhaustion | Limits, deadlines, transactional reservations | Token/request budgets needed for models with unknown prices. |
| XSS | React text rendering and CSP | Inline CSP allowance should be replaced by per-request nonces. |
| SQL injection | Prepared statements | Continue prohibiting dynamic user-controlled SQL fragments. |
| Worker crash | Leases, fencing token, attempt history, recovery | Provider calls can have ambiguous billed outcomes. |
| Dependency compromise | Lockfile, pinned CI actions, audit gate | Add automated update review and SBOM/signing. |
| Webhook forgery | Webhooks not implemented | Verify raw-body HMAC and delivery IDs before adding them. |
| File upload attacks | Attachment schema only; upload UI disabled | Add MIME sniffing, malware scanning, quotas, and isolated extraction before activation. |

## Reporting and operations

Audit events record security-relevant actions without credentials. Do not log request headers wholesale. Review failed connection checks, denied writes, repeated retries, and budget events. See `semantic-review/` for the independent implementation review and `docs/TESTING.md` for observed verification.
