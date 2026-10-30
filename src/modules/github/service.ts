import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { boundedSignal } from "@/src/core/signals";
import { getDb } from "@/src/core/database";
import { decryptSecret, encryptSecret } from "@/src/core/crypto";
import { writeAudit } from "@/src/core/audit";
import { assertOwnerActive, beginOwnerOperation } from "@/src/modules/lifecycle/owner-runtime";

const API = "https://api.github.com";
export const MAX_GITHUB_TEXT_BYTES = 256 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const headers = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "NEXUS-AI-OS/0.1" });

type OperationType = "branch" | "code_change" | "draft_pull_request";
type OperationState = "prepared" | "pending" | "reconciling" | "completed" | "failed";
type OperationRow = {
  id: string;
  payloadHash: string;
  state: OperationState;
  responseJson: string | null;
  branchName: string | null;
  baseRef: string | null;
  filePath: string | null;
  expectedFileSha: string | null;
  baseCommitSha: string | null;
  resultFileSha: string | null;
  resultCommitSha: string | null;
};
type FileSnapshot = { repo: string; requestedRef: string; resolvedCommitSha: string; path: string; sha: string; size: number; content: string };

export class GitHubServiceError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "GitHubServiceError";
  }
}

function validateRepo(repo: string): { owner: string; name: string; encoded: string } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new GitHubServiceError("Repository must use owner/name format.");
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name, encoded: `${encodeURIComponent(owner)}/${encodeURIComponent(name)}` };
}

function validateRef(ref: string, label = "ref"): string {
  if (!ref || ref.length > 200 || /[\u0000-\u0020~^:?*[\]\\]/.test(ref) || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".") || ref.includes("..") || ref.includes("//") || ref.includes("@{") || ref.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".lock"))) {
    throw new GitHubServiceError(`Invalid GitHub ${label}.`);
  }
  return ref;
}

function validateSha(sha: string, label = "SHA"): string {
  if (!SHA_PATTERN.test(sha)) throw new GitHubServiceError(`Invalid GitHub ${label}.`);
  return sha.toLowerCase();
}

function validateIdempotencyKey(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new GitHubServiceError("A valid UUID idempotency key is required.");
}

function validatePath(path: string): string {
  if (!path || Buffer.byteLength(path) > 1024 || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) throw new GitHubServiceError("Invalid repository file path.");
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git" || Buffer.byteLength(segment) > 255)) throw new GitHubServiceError("Invalid repository file path.");
  return path;
}

function validateText(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_GITHUB_TEXT_BYTES) throw new GitHubServiceError(`GitHub text files are limited to ${MAX_GITHUB_TEXT_BYTES} bytes.`, 413);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function operationMarker(idempotencyKey: string): string {
  return `nexus-operation:${idempotencyKey}`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "GitHub operation failed.";
  return message.slice(0, 1_000);
}

const githubOperationSignal = new AsyncLocalStorage<AbortSignal>();

async function runGitHubOperation<T>(userId: string, kind: string, operation: () => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
  const ownerOperation = beginOwnerOperation(userId, kind);
  const operationSignal = callerSignal ? AbortSignal.any([ownerOperation.signal, callerSignal]) : ownerOperation.signal;
  try { return await githubOperationSignal.run(operationSignal, operation); }
  finally { ownerOperation.end(); }
}

async function api<T = Record<string, unknown>>(token: string, path: string, init: RequestInit = {}, maxResponseBytes = 10 * 1024 * 1024): Promise<T> {
  const signal = boundedSignal(20_000, githubOperationSignal.getStore(), init.signal);
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...init.headers }, signal });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) throw new GitHubServiceError("GitHub response exceeded the permitted size.", 413);
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  if (responseBytes.byteLength > maxResponseBytes) throw new GitHubServiceError("GitHub response exceeded the permitted size.", 413);
  const text = new TextDecoder().decode(responseBytes);
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = null; }
  }
  if (!response.ok) {
    const message = typeof (data as { message?: unknown } | null)?.message === "string" ? String((data as { message: string }).message).slice(0, 500) : "Request failed";
    throw new GitHubServiceError(`GitHub returned ${response.status}: ${message}`, response.status);
  }
  return data as T;
}

function tokenFor(userId: string): { connectionId: string; token: string } {
  assertOwnerActive(userId);
  const row = getDb().prepare(`SELECT id, encrypted_token AS encryptedToken FROM github_connections
    WHERE user_id=? AND status='connected' ORDER BY updated_at DESC LIMIT 1`).get(userId) as { id: string; encryptedToken: string | null } | undefined;
  if (!row?.encryptedToken) throw new GitHubServiceError("Connect GitHub first.", 401);
  return { connectionId: row.id, token: decryptSecret(row.encryptedToken) };
}

function loadOperation(userId: string, operationType: OperationType, idempotencyKey: string): OperationRow | undefined {
  return getDb().prepare(`SELECT id,payload_hash AS payloadHash,state,response_json AS responseJson,branch_name AS branchName,
    base_ref AS baseRef,file_path AS filePath,expected_file_sha AS expectedFileSha,base_commit_sha AS baseCommitSha,
    result_file_sha AS resultFileSha,result_commit_sha AS resultCommitSha
    FROM github_write_operations WHERE user_id=? AND operation_type=? AND idempotency_key=?`)
    .get(userId, operationType, idempotencyKey) as OperationRow | undefined;
}

function prepareOperation(input: { userId: string; repo: string; operationType: OperationType; idempotencyKey: string; hash: string; branch?: string; base?: string; path?: string; expectedFileSha?: string | null }): { row: OperationRow; created: boolean } {
  const existing = loadOperation(input.userId, input.operationType, input.idempotencyKey);
  if (existing) {
    if (existing.payloadHash !== input.hash) throw new GitHubServiceError("The idempotency key was already used for a different request.", 409);
    return { row: existing, created: false };
  }
  const { owner, name } = validateRepo(input.repo);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    getDb().prepare(`INSERT INTO github_write_operations
      (id,user_id,repo_owner,repo_name,operation_type,idempotency_key,payload_hash,state,branch_name,base_ref,file_path,expected_file_sha,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'prepared',?,?,?,?,?,?)`)
      .run(id, input.userId, owner, name, input.operationType, input.idempotencyKey, input.hash, input.branch ?? null, input.base ?? null, input.path ?? null, input.expectedFileSha ?? null, now, now);
  } catch (error) {
    const raced = loadOperation(input.userId, input.operationType, input.idempotencyKey);
    if (!raced) throw error;
    if (raced.payloadHash !== input.hash) throw new GitHubServiceError("The idempotency key was already used for a different request.", 409);
    return { row: raced, created: false };
  }
  return { row: loadOperation(input.userId, input.operationType, input.idempotencyKey)!, created: true };
}

function claimOperation(id: string, fields: { baseCommitSha?: string | null } = {}): boolean {
  const now = new Date().toISOString();
  return getDb().prepare(`UPDATE github_write_operations
    SET state='pending',base_commit_sha=COALESCE(?,base_commit_sha),last_error=NULL,updated_at=?
    WHERE id=? AND state='prepared'`)
    .run(fields.baseCommitSha ?? null, now, id).changes === 1;
}

function updateOperation(id: string, state: Exclude<OperationState, "prepared" | "pending">, fields: { baseCommitSha?: string | null; resultFileSha?: string | null; resultCommitSha?: string | null; externalId?: string | null; externalUrl?: string | null; response?: unknown; error?: unknown } = {}): boolean {
  const now = new Date().toISOString();
  const allowed = state === "completed" ? ["prepared", "pending", "reconciling"] : state === "reconciling" ? ["pending"] : ["prepared", "pending", "reconciling"];
  const placeholders = allowed.map(() => "?").join(",");
  return getDb().prepare(`UPDATE github_write_operations SET state=?,base_commit_sha=COALESCE(?,base_commit_sha),result_file_sha=COALESCE(?,result_file_sha),
    result_commit_sha=COALESCE(?,result_commit_sha),external_id=COALESCE(?,external_id),external_url=COALESCE(?,external_url),
    response_json=COALESCE(?,response_json),last_error=?,updated_at=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END
    WHERE id=? AND state IN (${placeholders}) AND state <> 'completed'`)
    .run(state, fields.baseCommitSha ?? null, fields.resultFileSha ?? null, fields.resultCommitSha ?? null, fields.externalId ?? null, fields.externalUrl ?? null,
      fields.response === undefined ? null : JSON.stringify(fields.response), fields.error === undefined ? null : safeError(fields.error), now, state, now, id, ...allowed).changes === 1;
}

function loadOperationById(id: string): OperationRow {
  const row = getDb().prepare(`SELECT id,payload_hash AS payloadHash,state,response_json AS responseJson,branch_name AS branchName,
    base_ref AS baseRef,file_path AS filePath,expected_file_sha AS expectedFileSha,base_commit_sha AS baseCommitSha,
    result_file_sha AS resultFileSha,result_commit_sha AS resultCommitSha FROM github_write_operations WHERE id=?`).get(id) as OperationRow | undefined;
  if (!row) throw new GitHubServiceError("GitHub operation no longer exists.", 409);
  return row;
}

async function waitForOperation(id: string): Promise<OperationRow> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = loadOperationById(id);
    if (row.state === "completed" || row.state === "failed" || row.state === "reconciling") return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return loadOperationById(id);
}

function completedResponse(row: OperationRow): unknown | undefined {
  if (row.state !== "completed" || !row.responseJson) return undefined;
  return JSON.parse(row.responseJson);
}

function isAmbiguous(error: unknown): boolean {
  return !(error instanceof GitHubServiceError) || error.status === 429 || error.status >= 500;
}

async function repositoryRecord(token: string, encodedRepo: string): Promise<{ default_branch: string; [key: string]: unknown }> {
  return api(token, `/repos/${encodedRepo}`);
}

async function branchRef(token: string, encodedRepo: string, branch: string): Promise<{ ref: string; object: { sha: string; type?: string }; [key: string]: unknown }> {
  validateRef(branch, "branch");
  return api(token, `/repos/${encodedRepo}/git/ref/heads/${encodeURIComponent(branch)}`);
}

async function resolveCommit(token: string, encodedRepo: string, ref: string): Promise<{ sha: string; commit?: { message?: string }; [key: string]: unknown }> {
  validateRef(ref);
  return api(token, `/repos/${encodedRepo}/commits/${encodeURIComponent(ref)}`);
}

function decodeFileContent(data: { type?: string; encoding?: string; content?: string; size?: number; sha?: string }, requested: { repo: string; ref: string; resolvedCommitSha: string; path: string }): FileSnapshot {
  if (data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string" || typeof data.size !== "number" || typeof data.sha !== "string") throw new GitHubServiceError("GitHub did not return a regular base64-encoded file.", 422);
  if (data.size > MAX_GITHUB_TEXT_BYTES) throw new GitHubServiceError(`GitHub text files are limited to ${MAX_GITHUB_TEXT_BYTES} bytes.`, 413);
  const compact = data.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new GitHubServiceError("GitHub returned invalid base64 file content.", 502);
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length !== data.size || bytes.length > MAX_GITHUB_TEXT_BYTES) throw new GitHubServiceError("GitHub file size did not match its content.", 502);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new GitHubServiceError("Only valid UTF-8 text files can be inspected or changed.", 415); }
  return { repo: requested.repo, requestedRef: requested.ref, resolvedCommitSha: requested.resolvedCommitSha, path: requested.path, sha: data.sha, size: bytes.length, content };
}

async function readFileWithToken(token: string, repo: string, encodedRepo: string, ref: string, path: string): Promise<FileSnapshot> {
  const commit = await resolveCommit(token, encodedRepo, ref);
  const data = await api<{ type?: string; encoding?: string; content?: string; size?: number; sha?: string }>(token, `/repos/${encodedRepo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commit.sha)}`, {}, Math.ceil(MAX_GITHUB_TEXT_BYTES * 4 / 3) + 16_384);
  return decodeFileContent(data, { repo, ref, resolvedCommitSha: commit.sha, path });
}

async function readFileAtCommit(token: string, repo: string, encodedRepo: string, commitSha: string, path: string): Promise<FileSnapshot> {
  const data = await api<{ type?: string; encoding?: string; content?: string; size?: number; sha?: string }>(token, `/repos/${encodedRepo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(commitSha)}`, {}, Math.ceil(MAX_GITHUB_TEXT_BYTES * 4 / 3) + 16_384);
  return decodeFileContent(data, { repo, ref: commitSha, resolvedCommitSha: commitSha, path });
}

export async function connectGitHub(userId: string, token: string) {
  const operation = beginOwnerOperation(userId, "github_connection");
  try {
    const profile = await api<{ login: string; id: number }>(token, "/user", { signal: operation.signal });
    assertOwnerActive(userId);
    const id = randomUUID();
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO github_connections
      (id, user_id, connection_type, encrypted_token, login, permissions_json, status, created_at, updated_at)
      VALUES (?, ?, 'token', ?, ?, '{}', 'connected', ?, ?)`)
      .run(id, userId, encryptSecret(token), profile.login, now, now);
    writeAudit({ userId, action: "github.connected", resourceType: "github_connection", resourceId: id, outcome: "success", metadata: { login: profile.login } });
    return { id, login: profile.login };
  } finally {
    operation.end();
  }
}

export function githubStatus(userId: string) {
  return getDb().prepare(`SELECT id, connection_type AS connectionType, installation_id AS installationId, login,
    permissions_json AS permissionsJson, status, created_at AS createdAt, updated_at AS updatedAt
    FROM github_connections WHERE user_id=? ORDER BY updated_at DESC`).all(userId) as Array<Record<string, unknown>>;
}

async function listRepositoriesInternal(userId: string) {
  const { token } = tokenFor(userId);
  return api(token, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
}

async function repositoryOverviewInternal(userId: string, repo: string, signal?: AbortSignal) {
  const { encoded } = validateRepo(repo);
  const { token } = tokenFor(userId);
  const [repository, branches, issues, pulls, runs] = await Promise.all([
    api(token, `/repos/${encoded}`, { signal }),
    api(token, `/repos/${encoded}/branches?per_page=30`, { signal }),
    api(token, `/repos/${encoded}/issues?state=open&per_page=30`, { signal }),
    api(token, `/repos/${encoded}/pulls?state=open&per_page=30`, { signal }),
    api(token, `/repos/${encoded}/actions/runs?per_page=20`, { signal }).catch((error) => ({ error: safeError(error), workflow_runs: [] })),
  ]);
  writeAudit({ userId, action: "github.repository.read", resourceType: "repository", resourceId: repo, outcome: "success" });
  return { repository, branches, issues, pulls, runs };
}

async function readBranchInternal(userId: string, repo: string, branch: string) {
  const { encoded } = validateRepo(repo);
  validateRef(branch, "branch");
  const { token } = tokenFor(userId);
  return branchRef(token, encoded, branch);
}

async function readTreeInternal(userId: string, repo: string, sha: string, recursive = false) {
  const { encoded } = validateRepo(repo);
  validateSha(sha, "tree SHA");
  const { token } = tokenFor(userId);
  return api(token, `/repos/${encoded}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
}

async function compareRepositoryInternal(userId: string, repo: string, base: string, head: string) {
  const { encoded } = validateRepo(repo);
  validateRef(base, "base ref");
  validateRef(head, "head ref");
  const { token } = tokenFor(userId);
  return api(token, `/repos/${encoded}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
}

async function readTextFileInternal(userId: string, repo: string, ref: string, path: string): Promise<FileSnapshot> {
  const { encoded } = validateRepo(repo);
  validateRef(ref);
  validatePath(path);
  const { token } = tokenFor(userId);
  const result = await readFileWithToken(token, repo, encoded, ref, path);
  writeAudit({ userId, action: "github.file.read", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { path, requestedRef: ref, resolvedCommitSha: result.resolvedCommitSha, fileSha: result.sha } });
  return result;
}

async function previewTextFileChangeInternal(userId: string, repo: string, input: { ref: string; path: string; content: string }) {
  const { encoded } = validateRepo(repo);
  validateRef(input.ref);
  validatePath(input.path);
  validateText(input.content);
  const { token } = tokenFor(userId);
  let before: FileSnapshot | null = null;
  try { before = await readFileWithToken(token, repo, encoded, input.ref, input.path); }
  catch (error) { if (!(error instanceof GitHubServiceError) || error.status !== 404) throw error; }
  const hash = payloadHash({ repo, ref: input.ref, path: input.path, expectedSha: before?.sha ?? null, content: input.content });
  return {
    repo,
    ref: input.ref,
    resolvedCommitSha: before?.resolvedCommitSha ?? (await resolveCommit(token, encoded, input.ref)).sha,
    path: input.path,
    before: before ? { sha: before.sha, content: before.content, size: before.size } : null,
    after: { content: input.content, size: Buffer.byteLength(input.content), contentHash: createHash("sha256").update(input.content).digest("hex") },
    proposalHash: hash,
    changed: before?.content !== input.content,
  };
}

async function createIssueInternal(userId: string, repo: string, input: { title: string; body: string; confirm: boolean; idempotencyKey: string }) {
  validateRepo(repo);
  validateIdempotencyKey(input.idempotencyKey);
  if (!input.confirm) throw new GitHubServiceError("Explicit confirmation is required for GitHub writes.");
  const db = getDb();
  const route = `github.issue:${repo}`;
  const requestHash = createHash("sha256").update(JSON.stringify({ repo, title: input.title, body: input.body })).digest("hex");
  const marker = `<!-- ${operationMarker(input.idempotencyKey)} -->`;
  const prior = db.prepare(`SELECT request_hash AS requestHash, response_json AS responseJson FROM idempotency_keys
    WHERE user_id=? AND route=? AND idempotency_key=?`).get(userId, route, input.idempotencyKey) as { requestHash: string; responseJson: string | null } | undefined;
  if (prior) {
    if (prior.requestHash !== requestHash) throw new GitHubServiceError("The idempotency key was already used for a different request.", 409);
    if (prior.responseJson) return JSON.parse(prior.responseJson);
  }
  const { token } = tokenFor(userId);
  if (prior) {
    const recent = await api<Array<Record<string, unknown>>>(token, `/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`).catch(() => []);
    const recovered = recent.find((issue) => typeof issue.body === "string" && issue.body.includes(marker));
    if (!recovered) throw new GitHubServiceError("The previous GitHub operation has an unknown outcome. NEXUS will not repost it; retry later to reconcile.", 409);
    db.prepare(`UPDATE idempotency_keys SET status_code=201,response_json=? WHERE user_id=? AND route=? AND idempotency_key=?`).run(JSON.stringify(recovered), userId, route, input.idempotencyKey);
    return recovered;
  }
  db.prepare(`INSERT INTO idempotency_keys (user_id,route,idempotency_key,request_hash,created_at,expires_at) VALUES (?,?,?,?,?,?)`)
    .run(userId, route, input.idempotencyKey, requestHash, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  let result: Record<string, unknown>;
  try {
    result = await api(token, `/repos/${repo}/issues`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: input.title, body: `${input.body}\n\n${marker}` }) });
  } catch (error) {
    const recent = await api<Array<Record<string, unknown>>>(token, `/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`).catch(() => []);
    const recovered = recent.find((issue) => typeof issue.body === "string" && issue.body.includes(marker));
    if (!recovered) throw error;
    result = recovered;
  }
  db.prepare(`UPDATE idempotency_keys SET status_code=201,response_json=? WHERE user_id=? AND route=? AND idempotency_key=?`).run(JSON.stringify(result), userId, route, input.idempotencyKey);
  writeAudit({ userId, action: "github.issue.created", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { issueNumber: result.number, operationId: input.idempotencyKey } });
  return result;
}

async function reconcileBranch(token: string, encodedRepo: string, branch: string, expectedSha: string): Promise<boolean> {
  try { return (await branchRef(token, encodedRepo, branch)).object.sha === expectedSha; }
  catch (error) { if (error instanceof GitHubServiceError && error.status === 404) return false; throw error; }
}

async function createBranchInternal(userId: string, repo: string, input: { branch: string; base: string; confirm: boolean; idempotencyKey: string }) {
  const { encoded } = validateRepo(repo);
  validateRef(input.branch, "branch");
  validateRef(input.base, "base ref");
  validateIdempotencyKey(input.idempotencyKey);
  if (!input.confirm) throw new GitHubServiceError("Explicit confirmation is required for GitHub writes.");
  if (input.branch === input.base) throw new GitHubServiceError("Branch and base must differ.");
  const hash = payloadHash({ repo, branch: input.branch, base: input.base });
  const prepared = prepareOperation({ userId, repo, operationType: "branch", idempotencyKey: input.idempotencyKey, hash, branch: input.branch, base: input.base });
  const replay = completedResponse(prepared.row);
  if (replay !== undefined) return replay;
  const { token } = tokenFor(userId);
  if (prepared.row.state === "pending" || prepared.row.state === "reconciling") {
    const currentOperation = await waitForOperation(prepared.row.id);
    const completed = completedResponse(currentOperation);
    if (completed !== undefined) return completed;
    if (currentOperation.baseCommitSha && await reconcileBranch(token, encoded, input.branch, currentOperation.baseCommitSha)) {
      const recovered = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", branch: input.branch, base: input.base, sha: currentOperation.baseCommitSha };
      updateOperation(currentOperation.id, "completed", { resultCommitSha: currentOperation.baseCommitSha, response: recovered });
      return completedResponse(loadOperationById(currentOperation.id)) ?? recovered;
    }
    throw new GitHubServiceError("The previous branch operation is still pending or has an unknown outcome. NEXUS will not repost it.", 409);
  }
  if (prepared.row.state === "failed") throw new GitHubServiceError("This branch operation previously failed and will not be reposted with the same key.", 409);
  const repository = await repositoryRecord(token, encoded);
  if (input.branch === repository.default_branch) throw new GitHubServiceError("Direct default-branch writes are not allowed.", 409);
  const base = await branchRef(token, encoded, input.base);
  try {
    await branchRef(token, encoded, input.branch);
    updateOperation(prepared.row.id, "failed", { error: "Target branch already exists." });
    throw new GitHubServiceError("Target branch already exists; NEXUS will not overwrite it.", 409);
  } catch (error) {
    if (!(error instanceof GitHubServiceError) || error.status !== 404) throw error;
  }
  if (!claimOperation(prepared.row.id, { baseCommitSha: base.object.sha })) {
    const follower = await waitForOperation(prepared.row.id);
    const completed = completedResponse(follower);
    if (completed !== undefined) return completed;
    if (follower.baseCommitSha && await reconcileBranch(token, encoded, input.branch, follower.baseCommitSha)) {
      const recovered = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", branch: input.branch, base: input.base, sha: follower.baseCommitSha };
      updateOperation(follower.id, "completed", { resultCommitSha: follower.baseCommitSha, response: recovered });
      return completedResponse(loadOperationById(follower.id)) ?? recovered;
    }
    throw new GitHubServiceError("Another branch operation owns this idempotency key. NEXUS will not repost it.", 409);
  }
  try {
    const github = await api<Record<string, unknown>>(token, `/repos/${encoded}/git/refs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: base.object.sha }) });
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "created", branch: input.branch, base: input.base, sha: base.object.sha, github };
    updateOperation(prepared.row.id, "completed", { resultCommitSha: base.object.sha, response: result });
    writeAudit({ userId, action: "github.branch.created", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { branch: input.branch, base: input.base, sha: base.object.sha, operationId: input.idempotencyKey } });
    return result;
  } catch (error) {
    if (!isAmbiguous(error)) { updateOperation(prepared.row.id, "failed", { error }); throw error; }
    updateOperation(prepared.row.id, "reconciling", { error });
    if (await reconcileBranch(token, encoded, input.branch, base.object.sha)) {
      const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", branch: input.branch, base: input.base, sha: base.object.sha };
      updateOperation(prepared.row.id, "completed", { resultCommitSha: base.object.sha, response: result });
      return result;
    }
    throw new GitHubServiceError("GitHub did not confirm whether the branch was created. NEXUS will not repost it.", 502);
  }
}

async function reconcileFileChange(token: string, repo: string, encodedRepo: string, branch: string, path: string, content: string, marker: string): Promise<{ fileSha: string; commitSha: string } | null> {
  try {
    const ref = await branchRef(token, encodedRepo, branch);
    const file = await readFileAtCommit(token, repo, encodedRepo, ref.object.sha, path);
    if (file.content !== content) return null;
    const commit = await resolveCommit(token, encodedRepo, ref.object.sha);
    if (!commit.commit?.message?.includes(marker)) return null;
    return { fileSha: file.sha, commitSha: ref.object.sha };
  } catch (error) {
    if (error instanceof GitHubServiceError && error.status === 404) return null;
    throw error;
  }
}

async function applyTextFileChangeInternal(userId: string, repo: string, input: { branch: string; path: string; content: string; expectedSha: string | null; message: string; confirm: boolean; idempotencyKey: string }) {
  const { encoded } = validateRepo(repo);
  validateRef(input.branch, "branch");
  validatePath(input.path);
  validateText(input.content);
  if (input.expectedSha !== null) validateSha(input.expectedSha, "expected file SHA");
  validateIdempotencyKey(input.idempotencyKey);
  if (!input.message.trim() || input.message.length > 256) throw new GitHubServiceError("Commit message must contain 1 to 256 characters.");
  if (!input.confirm) throw new GitHubServiceError("Explicit confirmation is required for GitHub writes.");
  const hash = payloadHash({ repo, branch: input.branch, path: input.path, content: input.content, expectedSha: input.expectedSha, message: input.message });
  const prepared = prepareOperation({ userId, repo, operationType: "code_change", idempotencyKey: input.idempotencyKey, hash, branch: input.branch, path: input.path, expectedFileSha: input.expectedSha });
  const replay = completedResponse(prepared.row);
  if (replay !== undefined) return replay;
  const { token } = tokenFor(userId);
  const marker = operationMarker(input.idempotencyKey);
  if (prepared.row.state === "pending" || prepared.row.state === "reconciling") {
    const currentOperation = await waitForOperation(prepared.row.id);
    const completed = completedResponse(currentOperation);
    if (completed !== undefined) return completed;
    const recovered = await reconcileFileChange(token, repo, encoded, input.branch, input.path, input.content, marker);
    if (!recovered) throw new GitHubServiceError("The previous file operation is still pending or has an unknown outcome. NEXUS will not repost it.", 409);
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", branch: input.branch, path: input.path, fileSha: recovered.fileSha, commitSha: recovered.commitSha };
    updateOperation(currentOperation.id, "completed", { resultFileSha: recovered.fileSha, resultCommitSha: recovered.commitSha, response: result });
    return completedResponse(loadOperationById(currentOperation.id)) ?? result;
  }
  if (prepared.row.state === "failed") throw new GitHubServiceError("This file operation previously failed and will not be reposted with the same key.", 409);
  const repository = await repositoryRecord(token, encoded);
  if (input.branch === repository.default_branch) throw new GitHubServiceError("Direct default-branch writes are not allowed.", 409);
  const ref = await branchRef(token, encoded, input.branch);
  let current: FileSnapshot | null = null;
  try { current = await readFileAtCommit(token, repo, encoded, ref.object.sha, input.path); }
  catch (error) { if (!(error instanceof GitHubServiceError) || error.status !== 404) throw error; }
  if ((current?.sha ?? null) !== input.expectedSha) {
    updateOperation(prepared.row.id, "failed", { baseCommitSha: ref.object.sha, error: "Expected file SHA did not match." });
    throw new GitHubServiceError("The file changed after preview. Refresh the preview before applying.", 409);
  }
  if (current?.content === input.content) throw new GitHubServiceError("The proposed content is identical to the current file.", 409);
  if (!claimOperation(prepared.row.id, { baseCommitSha: ref.object.sha })) {
    const follower = await waitForOperation(prepared.row.id);
    const completed = completedResponse(follower);
    if (completed !== undefined) return completed;
    const recovered = await reconcileFileChange(token, repo, encoded, input.branch, input.path, input.content, marker);
    if (recovered) {
      const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", branch: input.branch, path: input.path, fileSha: recovered.fileSha, commitSha: recovered.commitSha };
      updateOperation(follower.id, "completed", { resultFileSha: recovered.fileSha, resultCommitSha: recovered.commitSha, response: result });
      return completedResponse(loadOperationById(follower.id)) ?? result;
    }
    throw new GitHubServiceError("Another file operation owns this idempotency key. NEXUS will not repost it.", 409);
  }
  const requestBody: Record<string, unknown> = { message: `${input.message.trim()}\n\n${marker}`, content: Buffer.from(input.content, "utf8").toString("base64"), branch: input.branch };
  if (input.expectedSha) requestBody.sha = input.expectedSha;
  try {
    const github = await api<{ content?: { sha?: string }; commit?: { sha?: string; html_url?: string }; [key: string]: unknown }>(token, `/repos/${encoded}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
    if (!github.content?.sha || !github.commit?.sha) throw new GitHubServiceError("GitHub returned an incomplete file-change result.", 502);
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "created", branch: input.branch, path: input.path, fileSha: github.content.sha, commitSha: github.commit.sha, commitUrl: github.commit.html_url ?? null };
    updateOperation(prepared.row.id, "completed", { resultFileSha: github.content.sha, resultCommitSha: github.commit.sha, externalId: github.commit.sha, externalUrl: github.commit.html_url ?? null, response: result });
    writeAudit({ userId, action: "github.file.changed", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { branch: input.branch, path: input.path, fileSha: github.content.sha, commitSha: github.commit.sha, operationId: input.idempotencyKey } });
    return result;
  } catch (error) {
    if (!isAmbiguous(error)) { updateOperation(prepared.row.id, "failed", { error }); throw error; }
    updateOperation(prepared.row.id, "reconciling", { error });
    const recovered = await reconcileFileChange(token, repo, encoded, input.branch, input.path, input.content, marker);
    if (!recovered) throw new GitHubServiceError("GitHub did not confirm whether the file changed. NEXUS will not repost it.", 502);
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", branch: input.branch, path: input.path, fileSha: recovered.fileSha, commitSha: recovered.commitSha };
    updateOperation(prepared.row.id, "completed", { resultFileSha: recovered.fileSha, resultCommitSha: recovered.commitSha, response: result });
    return result;
  }
}

async function findPullRequest(token: string, repoOwner: string, encodedRepo: string, input: { head: string; base: string; title: string; body: string }, marker: string) {
  const query = new URLSearchParams({ state: "all", head: `${repoOwner}:${input.head}`, base: input.base, per_page: "100" });
  const pulls = await api<Array<{ number?: number; title?: string; body?: string; draft?: boolean; html_url?: string; head?: { ref?: string }; base?: { ref?: string }; [key: string]: unknown }>>(token, `/repos/${encodedRepo}/pulls?${query}`);
  const expectedBody = `${input.body}\n\n<!-- ${marker} -->`;
  return pulls.find((pull) => pull.title === input.title && pull.body === expectedBody && pull.draft === true && pull.head?.ref === input.head && pull.base?.ref === input.base);
}

async function createPullRequestInternal(userId: string, repo: string, input: { title: string; body: string; head: string; base: string; confirm: boolean; idempotencyKey: string }) {
  const { owner, encoded } = validateRepo(repo);
  validateRef(input.head, "head branch");
  validateRef(input.base, "base branch");
  validateIdempotencyKey(input.idempotencyKey);
  if (!input.title.trim() || input.title.length > 256 || input.body.length > 65_000) throw new GitHubServiceError("Invalid pull-request title or body.");
  if (!input.confirm) throw new GitHubServiceError("Explicit confirmation is required for GitHub writes.");
  if (input.head === input.base) throw new GitHubServiceError("Pull request head and base must differ.");
  const hash = payloadHash({ repo, title: input.title, body: input.body, head: input.head, base: input.base, draft: true });
  const prepared = prepareOperation({ userId, repo, operationType: "draft_pull_request", idempotencyKey: input.idempotencyKey, hash, branch: input.head, base: input.base });
  const replay = completedResponse(prepared.row);
  if (replay !== undefined) return replay;
  const { token } = tokenFor(userId);
  const marker = operationMarker(input.idempotencyKey);
  if (prepared.row.state === "pending" || prepared.row.state === "reconciling") {
    const currentOperation = await waitForOperation(prepared.row.id);
    const completed = completedResponse(currentOperation);
    if (completed !== undefined) return completed;
    const recovered = await findPullRequest(token, owner, encoded, input, marker);
    if (!recovered) throw new GitHubServiceError("The previous pull-request operation is still pending or has an unknown outcome. NEXUS will not repost it.", 409);
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", number: recovered.number, url: recovered.html_url, draft: true, head: input.head, base: input.base };
    updateOperation(currentOperation.id, "completed", { externalId: String(recovered.number), externalUrl: recovered.html_url ?? null, response: result });
    return completedResponse(loadOperationById(currentOperation.id)) ?? result;
  }
  if (prepared.row.state === "failed") throw new GitHubServiceError("This pull-request operation previously failed and will not be reposted with the same key.", 409);
  const existing = await findPullRequest(token, owner, encoded, input, marker);
  if (existing) {
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", number: existing.number, url: existing.html_url, draft: true, head: input.head, base: input.base };
    updateOperation(prepared.row.id, "completed", { externalId: String(existing.number), externalUrl: existing.html_url ?? null, response: result });
    return result;
  }
  if (!claimOperation(prepared.row.id)) {
    const follower = await waitForOperation(prepared.row.id);
    const completed = completedResponse(follower);
    if (completed !== undefined) return completed;
    const recovered = await findPullRequest(token, owner, encoded, input, marker);
    if (recovered) {
      const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", number: recovered.number, url: recovered.html_url, draft: true, head: input.head, base: input.base };
      updateOperation(follower.id, "completed", { externalId: String(recovered.number), externalUrl: recovered.html_url ?? null, response: result });
      return completedResponse(loadOperationById(follower.id)) ?? result;
    }
    throw new GitHubServiceError("Another pull-request operation owns this idempotency key. NEXUS will not repost it.", 409);
  }
  try {
    const github = await api<{ number?: number; html_url?: string; [key: string]: unknown }>(token, `/repos/${encoded}/pulls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: input.title, body: `${input.body}\n\n<!-- ${marker} -->`, head: input.head, base: input.base, draft: true }) });
    if (typeof github.number !== "number") throw new GitHubServiceError("GitHub returned an incomplete pull-request result.", 502);
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "created", number: github.number, url: github.html_url ?? null, draft: true, head: input.head, base: input.base };
    updateOperation(prepared.row.id, "completed", { externalId: String(github.number), externalUrl: github.html_url ?? null, response: result });
    writeAudit({ userId, action: "github.pull_request.created", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { number: github.number, head: input.head, base: input.base, draft: true, operationId: input.idempotencyKey } });
    return result;
  } catch (error) {
    if (!isAmbiguous(error)) { updateOperation(prepared.row.id, "failed", { error }); throw error; }
    updateOperation(prepared.row.id, "reconciling", { error });
    const recovered = await findPullRequest(token, owner, encoded, input, marker);
    if (!recovered) throw new GitHubServiceError("GitHub did not confirm whether the draft pull request was created. NEXUS will not repost it.", 502);
    const result = { operationId: input.idempotencyKey, state: "completed", outcome: "reconciled", number: recovered.number, url: recovered.html_url, draft: true, head: input.head, base: input.base };
    updateOperation(prepared.row.id, "completed", { externalId: String(recovered.number), externalUrl: recovered.html_url ?? null, response: result });
    return result;
  }
}

export const listRepositories = (userId: string, signal?: AbortSignal) => runGitHubOperation(userId, "github_repositories", () => listRepositoriesInternal(userId), signal);
export const repositoryOverview = (userId: string, repo: string, signal?: AbortSignal) => runGitHubOperation(userId, "github_repository", () => repositoryOverviewInternal(userId, repo, signal), signal);
export const readBranch = (userId: string, repo: string, branch: string, signal?: AbortSignal) => runGitHubOperation(userId, "github_branch_read", () => readBranchInternal(userId, repo, branch), signal);
export const readTree = (userId: string, repo: string, sha: string, recursive = false, signal?: AbortSignal) => runGitHubOperation(userId, "github_tree_read", () => readTreeInternal(userId, repo, sha, recursive), signal);
export const compareRepository = (userId: string, repo: string, base: string, head: string, signal?: AbortSignal) => runGitHubOperation(userId, "github_compare", () => compareRepositoryInternal(userId, repo, base, head), signal);
export const readTextFile = (userId: string, repo: string, ref: string, path: string, signal?: AbortSignal) => runGitHubOperation(userId, "github_file_read", () => readTextFileInternal(userId, repo, ref, path), signal);
export const previewTextFileChange = (userId: string, repo: string, input: Parameters<typeof previewTextFileChangeInternal>[2], signal?: AbortSignal) => runGitHubOperation(userId, "github_change_preview", () => previewTextFileChangeInternal(userId, repo, input), signal);
export const createIssue = (userId: string, repo: string, input: Parameters<typeof createIssueInternal>[2], signal?: AbortSignal) => runGitHubOperation(userId, "github_issue_write", () => createIssueInternal(userId, repo, input), signal);
export const createBranch = (userId: string, repo: string, input: Parameters<typeof createBranchInternal>[2], signal?: AbortSignal) => runGitHubOperation(userId, "github_branch_write", () => createBranchInternal(userId, repo, input), signal);
export const applyTextFileChange = (userId: string, repo: string, input: Parameters<typeof applyTextFileChangeInternal>[2], signal?: AbortSignal) => runGitHubOperation(userId, "github_file_write", () => applyTextFileChangeInternal(userId, repo, input), signal);
export const createPullRequest = (userId: string, repo: string, input: Parameters<typeof createPullRequestInternal>[2], signal?: AbortSignal) => runGitHubOperation(userId, "github_pull_write", () => createPullRequestInternal(userId, repo, input), signal);
