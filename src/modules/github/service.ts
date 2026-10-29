import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { decryptSecret, encryptSecret } from "@/src/core/crypto";
import { writeAudit } from "@/src/core/audit";

const API = "https://api.github.com";
const headers = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "NEXUS-AI-OS/0.1" });

function validateRepo(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Repository must use owner/name format.");
}

async function api(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers(token), ...init.headers }, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${typeof data?.message === "string" ? data.message : "Request failed"}`);
  return data;
}

function tokenFor(userId: string): { connectionId: string; token: string } {
  const row = getDb().prepare(`SELECT id, encrypted_token AS encryptedToken FROM github_connections
    WHERE user_id=? AND status='connected' ORDER BY updated_at DESC LIMIT 1`).get(userId) as { id: string; encryptedToken: string | null } | undefined;
  if (!row?.encryptedToken) throw new Error("Connect GitHub first.");
  return { connectionId: row.id, token: decryptSecret(row.encryptedToken) };
}

export async function connectGitHub(userId: string, token: string) {
  const profile = await api(token, "/user") as { login: string; id: number };
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO github_connections
    (id, user_id, connection_type, encrypted_token, login, permissions_json, status, created_at, updated_at)
    VALUES (?, ?, 'token', ?, ?, '{}', 'connected', ?, ?)`)
    .run(id, userId, encryptSecret(token), profile.login, now, now);
  writeAudit({ userId, action: "github.connected", resourceType: "github_connection", resourceId: id, outcome: "success", metadata: { login: profile.login } });
  return { id, login: profile.login };
}

export function githubStatus(userId: string) {
  return getDb().prepare(`SELECT id, connection_type AS connectionType, installation_id AS installationId, login,
    permissions_json AS permissionsJson, status, created_at AS createdAt, updated_at AS updatedAt
    FROM github_connections WHERE user_id=? ORDER BY updated_at DESC`).all(userId) as Array<Record<string, unknown>>;
}

export async function listRepositories(userId: string) {
  const { token } = tokenFor(userId);
  return api(token, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
}

export async function repositoryOverview(userId: string, repo: string) {
  validateRepo(repo);
  const { token } = tokenFor(userId);
  const encoded = repo.split("/").map(encodeURIComponent).join("/");
  const [repository, branches, issues, pulls, runs] = await Promise.all([
    api(token, `/repos/${encoded}`),
    api(token, `/repos/${encoded}/branches?per_page=30`),
    api(token, `/repos/${encoded}/issues?state=open&per_page=30`),
    api(token, `/repos/${encoded}/pulls?state=open&per_page=30`),
    api(token, `/repos/${encoded}/actions/runs?per_page=20`).catch((error) => ({ error: error instanceof Error ? error.message : "Unavailable", workflow_runs: [] })),
  ]);
  writeAudit({ userId, action: "github.repository.read", resourceType: "repository", resourceId: repo, outcome: "success" });
  return { repository, branches, issues, pulls, runs };
}

export async function createIssue(userId: string, repo: string, input: { title: string; body: string; confirm: boolean; idempotencyKey: string }) {
  validateRepo(repo);
  if (!input.confirm) throw new Error("Explicit confirmation is required for GitHub writes.");
  const db = getDb();
  const route = `github.issue:${repo}`;
  const requestHash = createHash("sha256").update(JSON.stringify({ repo, title: input.title, body: input.body })).digest("hex");
  const { token } = tokenFor(userId);
  const marker = `<!-- nexus-operation:${input.idempotencyKey} -->`;
  const prior = db.prepare(`SELECT request_hash AS requestHash, response_json AS responseJson FROM idempotency_keys
    WHERE user_id=? AND route=? AND idempotency_key=?`).get(userId, route, input.idempotencyKey) as { requestHash: string; responseJson: string | null } | undefined;
  if (prior) {
    if (prior.requestHash !== requestHash) throw new Error("The idempotency key was already used for a different request.");
    if (prior.responseJson) return JSON.parse(prior.responseJson);
    const recent = await api(token, `/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`).catch(() => []) as Array<Record<string, unknown>>;
    const recovered = recent.find((issue) => typeof issue.body === "string" && issue.body.includes(marker));
    if (!recovered) throw new Error("The previous GitHub operation has an unknown outcome. NEXUS will not repost it; retry later to reconcile.");
    db.prepare(`UPDATE idempotency_keys SET status_code=201,response_json=? WHERE user_id=? AND route=? AND idempotency_key=?`)
      .run(JSON.stringify(recovered), userId, route, input.idempotencyKey);
    return recovered;
  }
  db.prepare(`INSERT INTO idempotency_keys (user_id,route,idempotency_key,request_hash,created_at,expires_at)
    VALUES (?,?,?,?,?,?)`).run(userId, route, input.idempotencyKey, requestHash, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
  let result: Record<string, unknown>;
  try {
    result = await api(token, `/repos/${repo}/issues`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: input.title, body: `${input.body}\n\n${marker}` }) });
  } catch (error) {
    const recent = await api(token, `/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`).catch(() => []) as Array<Record<string, unknown>>;
    const recovered = recent.find((issue) => typeof issue.body === "string" && issue.body.includes(marker));
    if (!recovered) throw error;
    result = recovered;
  }
  db.prepare(`UPDATE idempotency_keys SET status_code=201,response_json=? WHERE user_id=? AND route=? AND idempotency_key=?`)
    .run(JSON.stringify(result), userId, route, input.idempotencyKey);
  writeAudit({ userId, action: "github.issue.created", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { issueNumber: result.number, operationId: input.idempotencyKey } });
  return result;
}

export async function createBranch(userId: string, repo: string, input: { branch: string; base: string; confirm: boolean }) {
  validateRepo(repo);
  if (!input.confirm) throw new Error("Explicit confirmation is required for GitHub writes.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(input.branch) || input.branch.includes("..") || input.branch.endsWith("/")) throw new Error("Invalid branch name.");
  if (["main", "master"].includes(input.branch)) throw new Error("Direct default-branch writes are not allowed.");
  const { token } = tokenFor(userId);
  const base = await api(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(input.base)}`) as { object: { sha: string } };
  const result = await api(token, `/repos/${repo}/git/refs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: base.object.sha }) });
  writeAudit({ userId, action: "github.branch.created", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { branch: input.branch, base: input.base, sha: base.object.sha } });
  return result;
}

export async function createPullRequest(userId: string, repo: string, input: { title: string; body: string; head: string; base: string; draft?: boolean; confirm: boolean }) {
  validateRepo(repo);
  if (!input.confirm) throw new Error("Explicit confirmation is required for GitHub writes.");
  if (input.head === input.base) throw new Error("Pull request head and base must differ.");
  const { token } = tokenFor(userId);
  const existing = await api(token, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(repo.split("/")[0] + ":" + input.head)}&base=${encodeURIComponent(input.base)}`) as unknown[];
  if (existing.length) return existing[0];
  const result = await api(token, `/repos/${repo}/pulls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft ?? true }) });
  writeAudit({ userId, action: "github.pull_request.created", resourceType: "repository", resourceId: repo, outcome: "success", metadata: { number: result.number, head: input.head, base: input.base } });
  return result;
}
