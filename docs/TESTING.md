# Testing and verification

This file records observed results, not intended results. Update it when the implementation or environment changes.

## Test layers

- Unit: encryption, provider stream parsing, provider content/tool/structured mappings, local Ajv schema and output validation, schema safety limits, partial tool-call normalization, capability rejection, and SSRF policy.
- Integration: migrations/foreign keys, production clean-start output, atomic monetary/resource budgets and ledger recovery, owner/project/provider/run/agent scopes, broker/task enforcement, online backup and isolated restore/tamper/wrong-key evidence, evidence-aware research synthesis/citation/support/usage failure paths, durable concurrent and bounded multi-turn agent execution, broker authorization/schema/audit/quarantine controls, bounded durable messaging, human send, reply/correlation/hop/expiry/dedupe checks, internal-tool allow/deny, idempotent delegation, depth/task/deadline/cancellation limits, child execution and synthesis gating/context, trusted-memory context, bounded chat replay, mocked GitHub authorization and exact write reconciliation, artifact lifecycle, owner scoping, export secret exclusion, disconnect/scoped deletion, and whole-account filesystem-failure/retry/cascade/tombstone/re-bootstrap behavior.
- Browser: owner bootstrap and sign-in, protected routes/APIs, command center state, credential-free evidence-only multi-source research, citation provenance, and a mocked destructive account form that does not delete the shared E2E owner.
- Build/security: ESLint, strict TypeScript, Next.js production build, production dependency audit.

## Commands

```bash
npm run db:migrate
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run test:persistence
npm run test:production
npm run backup -- /absolute/backup/root
npm run restore:verify -- /absolute/bundle/path
npm audit --omit=dev
```

Tests use dedicated SQLite files under `data/`, all ignored by Git. Provider and model-backed research synthesis tests use controlled mock responses. The browser evidence-only research test retrieves `https://example.com/` and `https://example.org/` through the real constrained connector.

## Verification status

Final observed results on 2026-10-30 in the Kiro Linux sandbox:

- Clean migration: passed through `0010_security_reliability_boundaries.sql` with no transient Better Auth mismatch diagnostic.
- ESLint: passed with no warnings.
- Strict TypeScript: passed.
- Unit/integration: 154 tests passed across 28 files. Coverage includes provider wire-schema restrictions, bounded discovery and stale-response fencing, incremental SSE/text/tool-argument limits, dispatch-aware budget settlement and recovery, synchronized GitHub claims, authenticated backup tamper resistance, owner quiescence/drain, CSRF/content-type policy, evidence packet byte bounds, and production-runtime packaging.
- Production build: passed; 39 static-generation work items completed and all listed routes compiled, including `/api/v1/account/delete` and `/goodbye`.
- Playwright browser: 5 tests passed. The Settings lifecycle case includes the mocked destructive account flow, exact phrase gate, local-versus-remote warning, export recommendation, stale-key rotation, and completion-only goodbye redirect without deleting the shared owner. Research and budget cases also passed.
- Standalone production smoke: 1 test passed. Readiness reported `0010_security_reliability_boundaries.sql`, writable database/artifact storage, credential encryption, backup authentication, and unauthenticated redirect behavior.
- Standalone persistence smoke: passed with the latest schema and a retained marker across restart.
- Operator backup/verify: authenticated version-2 fixture and CLI verification passed; wrong/missing signing keys and coordinated database+manifest+checksum tampering failed closed.
- `npm audit` and `npm audit --omit=dev`: 0 known vulnerabilities.
- Container build/restart: configured as a CI job with a named-volume marker check, but not observed locally because this sandbox has no working container runtime. Do not treat the CI configuration as a passing result until a workflow run completes.
- Final independent semantic review: `semantic-review/2026-10-30-025950-pr-1.md` returned `APPROVED` with zero issues and no critical/high blockers.

## Credential-gated checks

No model-provider API credential was present. OpenAI-compatible, Anthropic, and Gemini adapters were contract-tested with controlled mock HTTP responses, including native Anthropic/Gemini discovery and stream behavior, but no live inference result is claimed. To promote a provider:

1. Connect a valid credential in an isolated test project.
2. Validate model discovery.
3. Add documented per-model pricing evidence in **Model Gateway** before enabling monetary limits for that model.
4. Run text and stream reconstruction.
5. Cancel before and after first byte.
6. Test invalid auth, unknown model, 429, 5xx, malformed stream, in-band error, and truncated stream.
7. Compare reported usage with the provider console.
8. Verify the budget reservation and settlement.
9. Record provider, model ID, date, request IDs, and sanitized evidence here.

The connected sandbox GitHub credential was verified by read-only discovery outside the application. Application-level token connection and repository reads use the same official REST surface. Branch, file-change, and draft-PR behavior was verified only with controlled mocked GitHub responses; no destructive or public write smoke test was performed.

## Release gate

A release requires clean migration, lint, typecheck, unit/integration, browser tests, build, zero known critical/high production dependency advisories, readiness, backup/restore evidence, a successful container or target-topology persistence run, and at least one live model-provider smoke test. Local backup/restore and standalone restart evidence now pass. No live provider credential or remote deployment was available, and the new container CI job has not yet produced an observed workflow result. The current tree is therefore a tested self-hostable beta candidate, not a verified hosted production release.

The final Playwright browser run passed all five cases. Model-backed research synthesis remains a mocked integration because no provider credential was available; the evidence-only multi-source browser path is live and credential-free.