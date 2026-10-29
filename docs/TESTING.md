# Testing and verification

This file records observed results, not intended results. Update it when the implementation or environment changes.

## Test layers

- Unit: encryption, provider stream parsing, provider normalization, SSRF policy.
- Integration: migrations/foreign keys, budgets, durable concurrent agent execution, lease/cancellation recovery.
- Browser: owner bootstrap and sign-in, protected routes/APIs, command center state, credential-free live web research, citation provenance.
- Build/security: ESLint, strict TypeScript, Next.js production build, production dependency audit.

## Commands

```bash
npm run db:migrate
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run test:production
npm audit --omit=dev
```

Tests use dedicated SQLite files under `data/`, all ignored by Git. Provider tests use clearly controlled mock HTTP responses. The browser research test retrieves `https://example.com/` through the real constrained connector.

## Verification status

Final observed results on 2026-10-29 in the Kiro Linux sandbox:

- Clean migration: passed; Better Auth schema plus `0001_core.sql` and `0002_security_and_usage.sql` applied.
- ESLint: passed with no warnings.
- Strict TypeScript: passed.
- Unit/integration: 28 assertions passed across 9 files. This includes concurrent agent execution, dependency synthesis, atomic usage settlement, global budgets across providers, deadline abort, cancelled-lease recovery, credential encryption, stream errors/truncation, and 15 SSRF cases.
- Production build: passed; 32 application/API routes compiled.
- Playwright browser suite: 3 passed. Owner bootstrap, protected pages/API, command center, and a live constrained fetch of `https://example.com/` with citation provenance were observed.
- Standalone production smoke: 1 passed. `start:production` migrated a clean database, started `.next/standalone/server.js`, returned readiness with migration `0002`, writable storage, and working encryption, and redirected an unauthenticated user to login.
- `npm audit --omit=dev`: 0 known production vulnerabilities.
- Independent security review: `semantic-review/2026-10-29-213700-pr-uncommitted.md` returned `APPROVED` for the documented single-owner, single-node beta boundary.
- Compose syntax/image execution: not verified because the sandbox container runtime lacks a working `conmon` binary. The same migration-first entrypoint was verified outside a container.

## Credential-gated checks

No model-provider API credential was present. OpenAI-compatible, Anthropic, and Gemini calls were contract-tested with mocks, but no live inference result is claimed. To promote a provider:

1. Connect a valid credential in an isolated test project.
2. Validate model discovery.
3. Add documented per-model pricing evidence in **Model Gateway** before enabling monetary limits for that model.
4. Run text and stream reconstruction.
5. Cancel before and after first byte.
6. Test invalid auth, unknown model, 429, 5xx, malformed stream, in-band error, and truncated stream.
7. Compare reported usage with the provider console.
8. Verify the budget reservation and settlement.
9. Record provider, model ID, date, request IDs, and sanitized evidence here.

The connected sandbox GitHub credential was verified by read-only discovery outside the application. Application-level token connection and repository reads use the same official REST surface, but destructive or public write smoke tests were not performed.

## Release gate

A release requires clean migration, lint, typecheck, unit/integration, browser tests, build, zero known critical/high production dependency advisories, readiness, backup/restore evidence, and at least one live model-provider smoke test. With no live provider credential and no remote deployment, the current artifact is a tested self-hostable beta, not a verified hosted production release.
