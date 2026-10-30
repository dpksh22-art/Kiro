# GitHub integration

## Scope

NEXUS uses GitHub's official REST API through a server-side token broker. The browser never receives the connected token. Repository and model content remains untrusted data, and GitHub workflows are never invoked by model or agent output.

No live GitHub write was performed while implementing or verifying this workflow. The integration suite uses an encrypted fake token and controlled `fetch` responses.

## Reads

Authenticated routes provide:

- `GET /api/v1/github/repositories` for authorized repository discovery.
- `GET /api/v1/github/repository?repo=owner/name` for repository, branch, issue, PR, and Actions summaries.
- `GET /api/v1/github/branches?repo=owner/name&branch=ref` for one explicit branch ref.
- `GET /api/v1/github/files?repo=owner/name&ref=ref-or-sha&path=path` for one text file.

File reads resolve the requested ref to a commit SHA before requesting content. Only regular base64-encoded files containing valid UTF-8 are accepted. Decoded content is limited to 256 KiB, and the encoded HTTP response is bounded as well. The service also exposes explicit-SHA tree reads and explicit base/head compare reads for server modules.

Repository names, refs, and paths are validated before a credential or network request is used. Paths must be relative, cannot contain empty, `.` or `..` segments, cannot address `.git`, and cannot contain backslashes or control characters.

## Exact change workflow

1. Create a non-default branch with `POST /api/v1/github/branches`. The request includes `repo`, `base`, `branch`, `confirm: true`, and a UUID `idempotencyKey`.
2. Inspect the target file at an explicit branch or SHA.
3. Submit `repo`, `ref`, `path`, and the complete proposed UTF-8 content to `POST /api/v1/github/changes/preview`. This is read-only. The response contains exact before/after text, the resolved commit SHA, current file SHA, proposed content hash, and canonical proposal hash.
4. Submit the exact proposed content to `POST /api/v1/github/changes/apply` with the preview's file SHA as `expectedSha`, a commit message, `confirm: true`, and a UUID operation key. New files use `expectedSha: null`.
5. Create a draft PR with `POST /api/v1/github/pulls`. The exact title, body, head, base, draft state, and operation key are bound together. The server always sends `draft: true`.

Apply re-resolves the branch and current file. It rejects the repository's current default branch and rejects a changed file SHA. It then creates or updates exactly one file through GitHub's Contents API. Updates include the expected blob SHA. The commit message includes a deterministic `nexus-operation:<uuid>` marker. NEXUS does not execute a shell, clone the repository, force-update a ref, merge a PR, or accept arbitrary patch commands.

## Durable idempotency and recovery

Migration `0004_github_write_operations.sql` stores owner, repository owner/name, operation type, UUID key, canonical payload hash, state, exact target metadata, base/file/commit SHAs, external IDs/URLs, sanitized errors, replay response, and timestamps. The unique owner/operation/key constraint prevents a second intent from using the same key. A changed payload returns HTTP 409.

Operation states are:

- `prepared`: validated and persisted before an external write starts.
- `pending`: an external write may be in flight.
- `reconciling`: the response was ambiguous and remote state must be checked.
- `completed`: exact remote state was persisted and can be replayed without a credential.
- `failed`: GitHub returned a definitive failure; the same key is not reposted.

Recovery never treats resource existence alone as success:

- A branch must point to the exact intended base SHA.
- A file must have the exact proposed content, and the branch-tip commit must contain the operation marker.
- A PR must match the marker, head, base, title, body, and `draft: true`, including when it is closed.

If reconciliation cannot prove the exact result, NEXUS leaves the operation closed to reposting and reports an unknown outcome. Issue creation continues to use the original `idempotency_keys` format and marker so existing completed and pending issue operations remain compatible.

## Permissions and deployment

A real request still requires a connected GitHub token with permissions for the selected repository and operation. "Credential-independent testing" means tests need no real GitHub credential; it does not mean GitHub accepts unauthenticated writes. Prefer short-lived GitHub App installation tokens. OAuth installation, token refresh, signed webhooks, and issuer-side revocation are not implemented.

GitHub branch protection and repository permissions remain authoritative. NEXUS surfaces GitHub failures without returning authorization headers or encrypted token values.
