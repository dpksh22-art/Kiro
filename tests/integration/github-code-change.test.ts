import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@/src/core/crypto";
import { getDb } from "@/src/core/database";
import {
  applyTextFileChange,
  compareRepository,
  createBranch,
  createIssue,
  createPullRequest,
  githubStatus,
  listRepositories,
  MAX_GITHUB_TEXT_BYTES,
  previewTextFileChange,
  readBranch,
  readTextFile,
  readTree,
} from "@/src/modules/github/service";
import { getTestUser } from "../helpers";

const ownerId = () => getTestUser();
const repo = "octo/example";
const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const fileA = "c".repeat(40);
const fileB = "d".repeat(40);

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function addConnection(token = "github-test-token-never-returned"): { token: string; ciphertext: string } {
  const ciphertext = encryptSecret(token);
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO github_connections (id,user_id,connection_type,encrypted_token,login,status,created_at,updated_at)
    VALUES (?,?, 'token',?,'octo','connected',?,?)`).run(randomUUID(), ownerId(), ciphertext, now, now);
  return { token, ciphertext };
}

function fileResponse(content: string, sha = fileA): Response {
  return json({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content), sha });
}

function requestDetails(input: string | URL | Request, init?: RequestInit) {
  return { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
}

beforeEach(() => {
  getDb().prepare("DELETE FROM github_write_operations").run();
  getDb().prepare("DELETE FROM idempotency_keys WHERE route LIKE 'github.%'").run();
  getDb().prepare("DELETE FROM github_connections").run();
});

afterEach(() => vi.unstubAllGlobals());

describe("credential-independent GitHub code-change workflow", () => {
  it("stores durable owner-scoped operation fields and omits encrypted tokens from status", () => {
    const { token, ciphertext } = addConnection();
    const columns = getDb().prepare("PRAGMA table_info(github_write_operations)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["repo_owner", "repo_name", "operation_type", "idempotency_key", "payload_hash", "state", "result_commit_sha", "created_at", "updated_at"]));
    const serialized = JSON.stringify(githubStatus(ownerId()));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(ciphertext);
    expect(serialized).not.toContain("encrypted_token");
  });

  it("sends auth only to GitHub and reads a UTF-8 file at a resolved immutable commit", async () => {
    const { token } = addConnection();
    const seen: ReturnType<typeof requestDetails>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init); seen.push(request);
      if (request.url.endsWith("/commits/feature%2Fsafe")) return json({ sha: commitA });
      if (request.url.includes(`/contents/src/readme.txt?ref=${commitA}`)) return fileResponse("safe UTF-8 ✓\n");
      return json({ message: "unexpected" }, 500);
    }));
    const result = await readTextFile(ownerId(), repo, "feature/safe", "src/readme.txt");
    expect(result).toMatchObject({ requestedRef: "feature/safe", resolvedCommitSha: commitA, content: "safe UTF-8 ✓\n" });
    expect(seen).toHaveLength(2);
    expect(seen.every((request) => request.headers.get("authorization") === `Bearer ${token}`)).toBe(true);
    expect(seen.every((request) => request.headers.get("x-github-api-version") === "2022-11-28")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("reads explicit branches and immutable trees and compares explicit refs", async () => {
    addConnection();
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input); urls.push(url);
      if (url.endsWith("/git/ref/heads/work")) return json({ ref: "refs/heads/work", object: { sha: commitA } });
      if (url.endsWith(`/git/trees/${commitA}?recursive=1`)) return json({ sha: commitA, tree: [] });
      if (url.endsWith("/compare/main...work")) return json({ status: "ahead", base_commit: { sha: commitA }, merge_base_commit: { sha: commitA }, commits: [] });
      return json({ message: "unexpected" }, 500);
    }));
    await expect(readBranch(ownerId(), repo, "work")).resolves.toMatchObject({ object: { sha: commitA } });
    await expect(readTree(ownerId(), repo, commitA, true)).resolves.toMatchObject({ sha: commitA });
    await expect(compareRepository(ownerId(), repo, "main", "work")).resolves.toMatchObject({ status: "ahead" });
    expect(urls).toEqual([
      "https://api.github.com/repos/octo/example/git/ref/heads/work",
      `https://api.github.com/repos/octo/example/git/trees/${commitA}?recursive=1`,
      "https://api.github.com/repos/octo/example/compare/main...work",
    ]);
  });

  it("rejects unsafe paths, refs, oversized files, and invalid UTF-8", async () => {
    addConnection();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(readTextFile(ownerId(), repo, "feature/../main", "README.md")).rejects.toThrow("Invalid GitHub ref");
    await expect(readTextFile(ownerId(), repo, "main", "../secret")).rejects.toThrow("Invalid repository file path");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockImplementationOnce(async () => json({ sha: commitA })).mockImplementationOnce(async () => json({ type: "file", encoding: "base64", content: "", size: MAX_GITHUB_TEXT_BYTES + 1, sha: fileA }));
    await expect(readTextFile(ownerId(), repo, "main", "large.txt")).rejects.toMatchObject({ status: 413 });

    fetchMock.mockImplementationOnce(async () => json({ sha: commitA })).mockImplementationOnce(async () => json({ type: "file", encoding: "base64", content: Buffer.from([0xff]).toString("base64"), size: 1, sha: fileA }));
    await expect(readTextFile(ownerId(), repo, "main", "binary.txt")).rejects.toMatchObject({ status: 415 });
  });

  it("generates exact before/after preview and hash without a GitHub write", async () => {
    addConnection();
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init); methods.push(request.method);
      if (request.url.endsWith("/commits/feature")) return json({ sha: commitA });
      return fileResponse("before\n", fileA);
    }));
    const preview = await previewTextFileChange(ownerId(), repo, { ref: "feature", path: "README.md", content: "after\n" });
    expect(preview).toMatchObject({ before: { sha: fileA, content: "before\n" }, after: { content: "after\n" }, changed: true });
    expect(preview.proposalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("requires confirmation before any write request and rejects invalid write targets", async () => {
    addConnection();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(createBranch(ownerId(), repo, { branch: "work", base: "main", confirm: false, idempotencyKey: randomUUID() })).rejects.toThrow("confirmation");
    await expect(applyTextFileChange(ownerId(), repo, { branch: "work", path: ".git/config", content: "x", expectedSha: null, message: "change", confirm: true, idempotencyKey: randomUUID() })).rejects.toThrow("Invalid repository file path");
    await expect(createPullRequest(ownerId(), repo, { title: "PR", body: "", head: "main", base: "main", confirm: true, idempotencyKey: randomUUID() })).rejects.toThrow("must differ");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a branch once, replays without credentials, and conflicts on changed payload", async () => {
    addConnection();
    const writes: ReturnType<typeof requestDetails>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init);
      if (request.method !== "GET") writes.push(request);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/main")) return json({ ref: "refs/heads/main", object: { sha: commitA } });
      if (request.url.endsWith("/git/ref/heads/nexus%2Fchange")) return json({ message: "Not Found" }, 404);
      if (request.url.endsWith("/git/refs") && request.method === "POST") return json({ ref: "refs/heads/nexus/change", object: { sha: commitA } }, 201);
      return json({ message: "unexpected" }, 500);
    }));
    const key = randomUUID();
    const input = { branch: "nexus/change", base: "main", confirm: true, idempotencyKey: key };
    const first = await createBranch(ownerId(), repo, input);
    expect(first).toMatchObject({ outcome: "created", sha: commitA });
    expect(writes).toHaveLength(1);
    getDb().prepare("DELETE FROM github_connections").run();
    await expect(createBranch(ownerId(), repo, input)).resolves.toEqual(first);
    await expect(createBranch(ownerId(), repo, { ...input, base: "develop" })).rejects.toMatchObject({ status: 409 });
    expect(writes).toHaveLength(1);
  });

  it("refuses to adopt or overwrite a pre-existing branch", async () => {
    addConnection();
    const requests: ReturnType<typeof requestDetails>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init); requests.push(request);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/main")) return json({ object: { sha: commitA } });
      if (request.url.endsWith("/git/ref/heads/work")) return json({ object: { sha: commitB } });
      return json({ message: "unexpected" }, 500);
    }));
    await expect(createBranch(ownerId(), repo, { branch: "work", base: "main", confirm: true, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("reconciles an ambiguous branch response and never force-updates a branch", async () => {
    addConnection();
    let targetReads = 0;
    const requests: ReturnType<typeof requestDetails>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init); requests.push(request);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/main")) return json({ object: { sha: commitA } });
      if (request.url.endsWith("/git/ref/heads/work")) return ++targetReads === 1 ? json({ message: "Not Found" }, 404) : json({ object: { sha: commitA } });
      if (request.url.endsWith("/git/refs")) throw new TypeError("socket closed");
      return json({ message: "unexpected" }, 500);
    }));
    await expect(createBranch(ownerId(), repo, { branch: "work", base: "main", confirm: true, idempotencyKey: randomUUID() })).resolves.toMatchObject({ outcome: "reconciled" });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(requests.some((request) => request.method === "PATCH" || String(request.body?.force) === "true")).toBe(false);
  });

  it("rejects default-branch file writes and enforces expected-SHA compare-and-swap", async () => {
    addConnection();
    const requests: ReturnType<typeof requestDetails>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init); requests.push(request);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/work")) return json({ object: { sha: commitA } });
      if (request.url.includes("/contents/README.md")) return fileResponse("old\n", fileB);
      return json({ message: "unexpected" }, 500);
    }));
    await expect(applyTextFileChange(ownerId(), repo, { branch: "main", path: "README.md", content: "new\n", expectedSha: fileA, message: "Update", confirm: true, idempotencyKey: randomUUID() })).rejects.toThrow("default-branch");
    await expect(applyTextFileChange(ownerId(), repo, { branch: "work", path: "README.md", content: "new\n", expectedSha: fileA, message: "Update", confirm: true, idempotencyKey: randomUUID() })).rejects.toThrow("changed after preview");
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(0);
  });

  it("updates one file through Contents API with expected SHA and deterministic marker", async () => {
    addConnection();
    const requests: ReturnType<typeof requestDetails>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init); requests.push(request);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/work")) return json({ object: { sha: commitA } });
      if (request.method === "GET" && request.url.includes("/contents/src%20file.txt")) return fileResponse("old", fileA);
      if (request.method === "PUT") return json({ content: { sha: fileB }, commit: { sha: commitB, html_url: "https://github.test/commit/b" } });
      return json({ message: "unexpected" }, 500);
    }));
    const key = randomUUID();
    const result = await applyTextFileChange(ownerId(), repo, { branch: "work", path: "src file.txt", content: "new ✓", expectedSha: fileA, message: "Update exact file", confirm: true, idempotencyKey: key });
    expect(result).toMatchObject({ outcome: "created", fileSha: fileB, commitSha: commitB });
    const put = requests.find((request) => request.method === "PUT")!;
    expect(put.url).toContain("/contents/src%20file.txt");
    expect(put.body).toMatchObject({ branch: "work", sha: fileA, content: Buffer.from("new ✓").toString("base64") });
    expect(String(put.body?.message)).toContain(`nexus-operation:${key}`);
    expect(requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    await expect(applyTextFileChange(ownerId(), repo, { branch: "work", path: "src file.txt", content: "changed", expectedSha: fileA, message: "Update exact file", confirm: true, idempotencyKey: key })).rejects.toMatchObject({ status: 409 });
  });

  it("reconciles an ambiguous file write by exact content and commit marker", async () => {
    addConnection();
    const key = randomUUID();
    let branchReads = 0;
    let contentReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/work")) return json({ object: { sha: ++branchReads === 1 ? commitA : commitB } });
      if (request.method === "GET" && request.url.includes("/contents/README.md")) return ++contentReads === 1 ? fileResponse("old", fileA) : fileResponse("new", fileB);
      if (request.method === "PUT") throw new TypeError("connection reset");
      if (request.url.endsWith(`/commits/${commitB}`)) return json({ sha: commitB, commit: { message: `Update\n\nnexus-operation:${key}` } });
      return json({ message: "unexpected" }, 500);
    }));
    await expect(applyTextFileChange(ownerId(), repo, { branch: "work", path: "README.md", content: "new", expectedSha: fileA, message: "Update", confirm: true, idempotencyKey: key })).resolves.toMatchObject({ outcome: "reconciled", commitSha: commitB });
    expect(getDb().prepare("SELECT state,result_commit_sha AS sha FROM github_write_operations WHERE idempotency_key=?").get(key)).toEqual({ state: "completed", sha: commitB });
  });

  it("creates only an exact draft PR and deduplicates ambiguous outcomes", async () => {
    addConnection();
    const key = randomUUID();
    let searches = 0;
    const requests: ReturnType<typeof requestDetails>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init); requests.push(request);
      if (request.method === "GET" && request.url.includes("/pulls?")) {
        searches += 1;
        return searches === 1 ? json([]) : json([{ number: 7, title: "Exact PR", body: `Body\n\n<!-- nexus-operation:${key} -->`, draft: true, html_url: "https://github.test/pr/7", head: { ref: "work" }, base: { ref: "main" } }]);
      }
      if (request.method === "POST" && request.url.endsWith("/pulls")) throw new TypeError("timeout after send");
      return json({ message: "unexpected" }, 500);
    }));
    const input = { title: "Exact PR", body: "Body", head: "work", base: "main", confirm: true, idempotencyKey: key };
    await expect(createPullRequest(ownerId(), repo, input)).resolves.toMatchObject({ outcome: "reconciled", number: 7, draft: true });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
    const post = requests.find((request) => request.method === "POST")!;
    expect(post.body).toMatchObject({ title: "Exact PR", body: `Body\n\n<!-- nexus-operation:${key} -->`, head: "work", base: "main", draft: true });
    getDb().prepare("DELETE FROM github_connections").run();
    await expect(createPullRequest(ownerId(), repo, input)).resolves.toMatchObject({ number: 7 });
  });

  it("fails closed and does not repost when a pending draft PR cannot be reconciled", async () => {
    addConnection();
    const key = randomUUID();
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init);
      if (request.method === "GET" && request.url.includes("/pulls?")) return json([]);
      if (request.method === "POST") { posts += 1; throw new TypeError("timeout after send"); }
      return json({ message: "unexpected" }, 500);
    }));
    const input = { title: "Exact PR", body: "Body", head: "work", base: "main", confirm: true, idempotencyKey: key };
    await expect(createPullRequest(ownerId(), repo, input)).rejects.toThrow("did not confirm");
    await expect(createPullRequest(ownerId(), repo, input)).rejects.toThrow("unknown outcome");
    expect(posts).toBe(1);
    expect(getDb().prepare("SELECT state FROM github_write_operations WHERE idempotency_key=?").get(key)).toEqual({ state: "reconciling" });
  });

  it("keeps completed issue idempotency rows compatible with the original hash", async () => {
    const key = randomUUID();
    const title = "Existing operation";
    const body = "Already completed";
    const hash = createHash("sha256").update(JSON.stringify({ repo, title, body })).digest("hex");
    const now = new Date().toISOString();
    getDb().prepare(`INSERT INTO idempotency_keys (user_id,route,idempotency_key,request_hash,status_code,response_json,created_at,expires_at)
      VALUES (?,?,?,?,201,?,?,?)`).run(ownerId(), `github.issue:${repo}`, key, hash, JSON.stringify({ number: 42, title }), now, now);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(createIssue(ownerId(), repo, { title, body, confirm: true, idempotencyKey: key })).resolves.toMatchObject({ number: 42 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 401 from GitHub file routes before contacting GitHub", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const { GET } = await import("@/app/api/v1/github/files/route");
    const response = await GET(new Request("http://localhost/api/v1/github/files?repo=octo%2Fexample&ref=main&path=README.md"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("atomic concurrent GitHub claims", () => {
  it("allows only one concurrent branch POST and leaves a completed intent", async () => {
    addConnection(); const key = randomUUID(); let posts = 0; let created = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/main")) return json({ object: { sha: commitA } });
      if (request.url.endsWith("/git/ref/heads/concurrent")) return created ? json({ object: { sha: commitA } }) : json({ message: "Not Found" }, 404);
      if (request.method === "POST") { posts += 1; created = true; return json({ ref: "refs/heads/concurrent", object: { sha: commitA } }, 201); }
      return json({ message: "unexpected" }, 500);
    }));
    const input = { branch: "concurrent", base: "main", confirm: true, idempotencyKey: key };
    const results = await Promise.allSettled([createBranch(ownerId(), repo, input), createBranch(ownerId(), repo, input)]);
    expect(posts).toBe(1);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(getDb().prepare("SELECT state FROM github_write_operations WHERE idempotency_key=?").get(key)).toEqual({ state: "completed" });
  });

  it("allows only one concurrent file PUT and leaves a completed intent", async () => {
    addConnection(); const key = randomUUID(); let puts = 0; let updated = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/work")) return json({ object: { sha: updated ? commitB : commitA } });
      if (request.method === "PUT") { puts += 1; updated = true; return json({ content: { sha: fileB }, commit: { sha: commitB } }); }
      if (request.url.includes("/contents/README.md")) return updated ? fileResponse("new", fileB) : fileResponse("old", fileA);
      if (request.url.endsWith(`/commits/${commitB}`)) return json({ sha: commitB, commit: { message: `Update\n\nnexus-operation:${key}` } });
      return json({ message: "unexpected" }, 500);
    }));
    const input = { branch: "work", path: "README.md", content: "new", expectedSha: fileA, message: "Update", confirm: true, idempotencyKey: key };
    const results = await Promise.allSettled([applyTextFileChange(ownerId(), repo, input), applyTextFileChange(ownerId(), repo, input)]);
    expect(puts).toBe(1);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(getDb().prepare("SELECT state FROM github_write_operations WHERE idempotency_key=?").get(key)).toEqual({ state: "completed" });
  });

  it("allows only one concurrent draft-PR POST and leaves a completed intent", async () => {
    addConnection(); const key = randomUUID(); let posts = 0; let created = false;
    const recovered = { number: 9, title: "Concurrent", body: `Body\n\n<!-- nexus-operation:${key} -->`, draft: true, html_url: "https://github.test/pr/9", head: { ref: "work" }, base: { ref: "main" } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestDetails(input, init);
      if (request.method === "GET" && request.url.includes("/pulls?")) return json(created ? [recovered] : []);
      if (request.method === "POST") { posts += 1; created = true; return json(recovered, 201); }
      return json({ message: "unexpected" }, 500);
    }));
    const input = { title: "Concurrent", body: "Body", head: "work", base: "main", confirm: true, idempotencyKey: key };
    const results = await Promise.allSettled([createPullRequest(ownerId(), repo, input), createPullRequest(ownerId(), repo, input)]);
    expect(posts).toBe(1);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(getDb().prepare("SELECT state FROM github_write_operations WHERE idempotency_key=?").get(key)).toEqual({ state: "completed" });
  });
});


describe("GitHub caller cancellation", () => {
  it("propagates caller cancellation during a credentialed read", async () => {
    addConnection(); const controller = new AbortController(); let started!: () => void; const pending = new Promise<void>((resolve) => { started = resolve; });
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started(); init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const request = listRepositories(ownerId(), controller.signal);
    await pending; controller.abort();
    await expect(request).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not repost after caller cancellation reaches a dispatched branch write", async () => {
    addConnection(); const controller = new AbortController(); const key = randomUUID(); let posts = 0; let postStarted!: () => void; const started = new Promise<void>((resolve) => { postStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      const request = requestDetails(input, init);
      if (request.url === "https://api.github.com/repos/octo/example") return json({ default_branch: "main" });
      if (request.url.endsWith("/git/ref/heads/main")) return json({ object: { sha: commitA } });
      if (request.url.endsWith("/git/ref/heads/cancelled")) return json({ message: "Not Found" }, 404);
      if (request.method === "POST") {
        posts += 1; postStarted();
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      }
      return json({ message: "unexpected" }, 500);
    }));
    const write = createBranch(ownerId(), repo, { branch: "cancelled", base: "main", confirm: true, idempotencyKey: key }, controller.signal);
    await started; controller.abort();
    await expect(write).rejects.toBeTruthy();
    expect(posts).toBe(1);
    expect(getDb().prepare("SELECT state FROM github_write_operations WHERE idempotency_key=?").get(key)).toEqual({ state: "reconciling" });
  });
});
