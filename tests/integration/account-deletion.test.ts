import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/src/core/database";
import { encryptSecret } from "@/src/core/crypto";
import { createBranch } from "@/src/modules/github/service";
import { createOwnerExport } from "@/src/modules/lifecycle/export";
import { ACCOUNT_DELETION_CONFIRMATION, deleteOwnerAccount, getAccountDeletionJobForTests } from "@/src/modules/lifecycle/account-deletion";
import { cleanupOwnerArtifactContent, resolveArtifactPath, uploadArtifact } from "@/src/modules/artifacts/service";
import { activeOwnerOperationCountForTests, beginOwnerOperation } from "@/src/modules/lifecycle/owner-runtime";
import { getTestUser } from "../helpers";

const stream = (value: string) => new Blob([value]).stream();

function populateOwnerGraph(userId: string) {
  const db = getDb();
  const id = () => randomUUID();
  const now = new Date().toISOString();
  const provider = id();
  const project = id();
  const conversation = id();
  const message = id();
  const agent = id();
  const team = id();
  const run = id();
  const parentTask = id();
  const childTask = id();
  const attempt = id();
  const source = id();
  const report = id();
  const tool = id();

  db.prepare("UPDATE user SET email=?,name=? WHERE id=?").run("delete-owner@nexus.test", "Delete Owner", userId);
  db.prepare(`INSERT INTO account (id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?, 'credential',?,'password-hash-must-disappear',?,?)`).run(id(), "delete-owner@nexus.test", userId, now, now);
  db.prepare(`INSERT INTO session (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)`).run(id(), new Date(Date.now() + 60_000).toISOString(), "session-token-must-disappear", now, now, userId);
  db.prepare(`INSERT INTO verification (id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`).run(id(), "delete-owner@nexus.test", userId, new Date(Date.now() + 60_000).toISOString(), now, now);
  db.prepare(`INSERT INTO provider_connections (id,user_id,provider,label,encrypted_credential,status,created_at,updated_at) VALUES (?,?, 'openai','delete fixture','provider-ciphertext-must-disappear','connected',?,?)`).run(provider, userId, now, now);
  db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,availability,created_at,updated_at) VALUES (?,?, 'fixture-model','Fixture','available',?,?)`).run(id(), provider, now, now);
  db.prepare(`INSERT INTO projects (id,user_id,name,created_at,updated_at) VALUES (?,?,'Delete fixture',?,?)`).run(project, userId, now, now);
  db.prepare(`INSERT INTO conversations (id,project_id,user_id,title,mode,created_at,updated_at) VALUES (?,?,?,'Delete fixture','single',?,?)`).run(conversation, project, userId, now, now);
  db.prepare(`INSERT INTO messages (id,conversation_id,role,status,content,created_at) VALUES (?,?,'user','completed','message must disappear',?)`).run(message, conversation, now);
  db.prepare(`INSERT INTO agents (id,user_id,slug,name,role,instructions,created_at,updated_at) VALUES (?,?,?,'Delete agent','worker','fixture',?,?)`).run(agent, userId, `delete-${agent}`, now, now);
  db.prepare(`INSERT INTO agent_teams (id,user_id,name,created_at,updated_at) VALUES (?,?,'Delete team',?,?)`).run(team, userId, now, now);
  db.prepare("INSERT INTO agent_team_members (team_id,agent_id) VALUES (?,?)").run(team, agent);
  db.prepare(`INSERT INTO task_runs (id,user_id,project_id,conversation_id,title,goal,mode,status,created_at,updated_at) VALUES (?,?,?,?, 'Delete run','delete','single','succeeded',?,?)`).run(run, userId, project, conversation, now, now);
  db.prepare(`INSERT INTO tasks (id,run_id,assigned_agent_id,task_key,title,description,task_type,status,created_at,updated_at) VALUES (?,?,?,'parent','Parent','fixture','worker','succeeded',?,?)`).run(parentTask, run, agent, now, now);
  db.prepare(`INSERT INTO tasks (id,run_id,parent_task_id,assigned_agent_id,task_key,title,description,task_type,status,created_at,updated_at) VALUES (?,?,?,?, 'child','Child','fixture','worker','succeeded',?,?)`).run(childTask, run, parentTask, agent, now, now);
  db.prepare(`INSERT INTO task_dependencies (task_id,depends_on_task_id) VALUES (?,?)`).run(childTask, parentTask);
  db.prepare(`INSERT INTO task_attempts (id,task_id,attempt_number,status) VALUES (?,?,1,'succeeded')`).run(attempt, parentTask);
  db.prepare(`INSERT INTO task_events (id,run_id,task_id,event_type,actor_type,payload_json,created_at) VALUES (?,?,?,'fixture','system','{}',?)`).run(id(), run, parentTask, now);
  const agentMessage = id();
  db.prepare(`INSERT INTO agent_messages (id,run_id,task_id,sender_agent_id,recipient_agent_id,message_type,body_json,created_at,expires_at,updated_at) VALUES (?,?,?,?,?,'fixture','{}',?,?,?)`).run(agentMessage, run, parentTask, agent, agent, now, new Date(Date.now() + 60_000).toISOString(), now);
  db.prepare(`INSERT INTO run_agent_participants (run_id,agent_id,source,instructions,allowed_tools_json,permission_policy_json,budget_json,max_duration_seconds,max_turns,completion_criteria,created_at) VALUES (?,?,'initial','fixture','[]','{}','{}',60,1,'done',?)`).run(run, agent, now);
  db.prepare(`INSERT INTO task_delegations (id,run_id,parent_task_id,child_task_id,recipient_agent_id,message_id,fingerprint,idempotency_key,correlation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id(), run, parentTask, childTask, agent, agentMessage, randomUUID(), randomUUID(), randomUUID(), now);
  db.prepare(`INSERT INTO tool_invocations (id,user_id,run_id,task_id,tool_name,permission_scope,status,arguments_json,started_at,updated_at) VALUES (?,?,?,?, 'fixture','read','completed','{}',?,?)`).run(tool, userId, run, parentTask, now, now);
  db.prepare(`INSERT INTO research_sources (id,user_id,run_id,connector,source_type,canonical_url,retrieved_at,content_hash) VALUES (?,?,?,'web','html','https://example.test/delete',?,'source-hash')`).run(source, userId, run, now);
  db.prepare(`INSERT INTO research_reports (id,user_id,run_id,title,body,created_at) VALUES (?,?,?,'Delete report','report must disappear',?)`).run(report, userId, run, now);
  db.prepare(`INSERT INTO research_report_sources (report_id,source_id,citation_ordinal) VALUES (?,?,1)`).run(report, source);
  db.prepare(`INSERT INTO github_connections (id,user_id,connection_type,encrypted_token,status,created_at,updated_at) VALUES (?,?,'token','github-ciphertext-must-disappear','connected',?,?)`).run(id(), userId, now, now);
  db.prepare(`INSERT INTO github_write_operations (id,user_id,repo_owner,repo_name,operation_type,idempotency_key,payload_hash,state,created_at,updated_at) VALUES (?,?,'owner','repo','branch',?,?,'completed',?,?)`).run(id(), userId, randomUUID(), "a".repeat(64), now, now);
  db.prepare(`INSERT INTO budget_policies (id,user_id,period,hard_limit_micros,behavior,created_at,updated_at) VALUES (?,?,'daily',100,'stop',?,?)`).run(id(), userId, now, now);
  const usage = id();
  db.prepare(`INSERT INTO usage_records (id,user_id,run_id,message_id,provider,model_id,status,created_at) VALUES (?,?,?,?, 'openai','fixture','settled',?)`).run(usage, userId, run, message, now);
  db.prepare(`INSERT INTO resource_budget_policies (id,user_id,unit,scope_type,period,hard_limit,created_at,updated_at) VALUES (?,?,'model_calls','owner','daily',10,?,?)`).run(id(), userId, now, now);
  db.prepare(`INSERT INTO resource_usage_records (id,reservation_group_id,user_id,run_id,task_id,attempt_id,message_id,usage_record_id,tool_invocation_id,unit,reserved_units,consumed_units,status,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?,'model_calls',1,1,'consumed',?,?)`).run(id(), id(), userId, run, parentTask, attempt, message, usage, tool, now, now);
  db.prepare(`INSERT INTO project_memories (id,user_id,project_id,kind,content,retention_policy,created_at,updated_at) VALUES (?,?,?,'decision','memory must disappear','permanent',?,?)`).run(id(), userId, project, now, now);
  db.prepare(`INSERT INTO notifications (id,user_id,type,title,body,created_at) VALUES (?,?,'fixture','Delete','notification must disappear',?)`).run(id(), userId, now);
  db.prepare(`INSERT INTO idempotency_keys (user_id,route,idempotency_key,request_hash,created_at,expires_at) VALUES (?,'fixture',?,'fixture',?,?)`).run(userId, randomUUID(), now, new Date(Date.now() + 60_000).toISOString());
  return { run, parentTask, source, report, agent, provider, project, conversation, message };
}

describe("whole-account deletion", () => {
  it("retains the owner on filesystem failure, resumes safely, cascades all owner data, and permits one replacement owner", async () => {
    const db = getDb();
    const userId = getTestUser();
    const ids = populateOwnerGraph(userId);
    const artifact = await uploadArtifact({ userId, filename: "delete-me.txt", declaredMediaType: "text/plain", stream: stream("account deletion bytes") });
    const stored = db.prepare("SELECT storage_path AS storagePath,content_hash AS contentHash,byte_size AS byteSize FROM artifacts WHERE id=?").get(artifact.id) as { storagePath: string; contentHash: string; byteSize: number };
    db.prepare(`INSERT INTO attachments (id,user_id,message_id,artifact_id,filename,media_type,byte_size,content_hash,storage_path,created_at) VALUES (?,?,?,?, 'attached.txt','text/plain',?,?,?,?)`).run(randomUUID(), userId, ids.message, artifact.id, stored.byteSize, stored.contentHash, stored.storagePath, new Date().toISOString());
    const physicalPath = resolveArtifactPath(stored.storagePath);

    const exported = JSON.parse(await new Response(createOwnerExport(userId)).text()) as { data: Record<string, unknown[]> };
    expect(exported.data.projects!.length).toBeGreaterThan(0);
    expect(exported.data.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ id: artifact.id })]));
    expect(JSON.stringify(exported)).not.toContain("ciphertext-must-disappear");

    await expect(deleteOwnerAccount({ userId, confirmation: "DELETE MY ACCOUNT", idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "confirmation_mismatch", status: 400 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM account_deletion_jobs").get()).toEqual({ count: 0 });

    const key = randomUUID();
    db.prepare("UPDATE artifacts SET storage_path='../../escape',content_hash=? WHERE id=?").run("b".repeat(64), artifact.id);
    await expect(deleteOwnerAccount({ userId, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: key })).rejects.toMatchObject({ code: "deletion_failed", status: 503 });
    expect(db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)).toBeTruthy();
    db.prepare("UPDATE artifacts SET storage_path=?,content_hash=? WHERE id=?").run(stored.storagePath, stored.contentHash, artifact.id);

    let jobId = "";
    await expect(deleteOwnerAccount({
      userId,
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      idempotencyKey: key,
      artifactOptions: { async removeFile() { throw new Error("sensitive /host/path and password"); } },
    })).rejects.toMatchObject({ code: "deletion_failed", status: 503 });
    const failed = db.prepare("SELECT id,state,sanitized_error AS error FROM account_deletion_jobs WHERE idempotency_key=?").get(key) as { id: string; state: string; error: string };
    jobId = failed.id;
    expect(failed.state).toBe("failed");
    expect(failed.error).not.toMatch(/host|password|delete-me/i);
    expect(db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)).toBeTruthy();
    expect(db.prepare("SELECT encrypted_credential FROM provider_connections WHERE id=?").get(ids.provider)).toBeTruthy();
    expect(existsSync(physicalPath)).toBe(true);
    expect(db.prepare("SELECT upload_state FROM artifacts WHERE id=?").get(artifact.id)).toEqual({ upload_state: "deleting" });

    await expect(deleteOwnerAccount({ userId, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: "idempotency_change_conflict", status: 409 });
    await expect(deleteOwnerAccount({ userId: "different-owner", confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: key })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });

    await expect(cleanupOwnerArtifactContent({ userId, jobId, finalize() { throw new Error("simulated crash before final database transaction"); } })).rejects.toThrow(/simulated crash/);
    expect(getAccountDeletionJobForTests(jobId).state).toBe("deleting_files");
    expect(db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)).toBeTruthy();
    expect(existsSync(physicalPath)).toBe(false);

    const completed = await deleteOwnerAccount({ userId, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: key });
    expect(completed).toMatchObject({ jobId, state: "completed", retryable: false, artifactCount: expect.any(Number), attachmentCount: expect.any(Number), uniquePathCount: expect.any(Number) });
    expect(completed.artifactCount).toBeGreaterThan(0);
    expect(completed.attachmentCount).toBeGreaterThan(0);
    expect(existsSync(physicalPath)).toBe(false);
    expect(db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM account WHERE userId=?").get(userId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM session WHERE userId=?").get(userId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM verification WHERE value=? OR identifier=?").get(userId, "delete-owner@nexus.test")).toBeUndefined();
    for (const table of ["provider_connections", "projects", "conversations", "attachments", "agents", "agent_teams", "task_runs", "artifacts", "tool_invocations", "research_sources", "research_reports", "github_connections", "budget_policies", "usage_records", "notifications", "idempotency_keys", "project_memories", "github_write_operations", "resource_budget_policies", "resource_usage_records"]) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`).get(userId) as { count: number }).count, table).toBe(0);
    }
    expect(db.prepare("SELECT 1 FROM tasks WHERE run_id=?").get(ids.run)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM research_report_sources WHERE report_id=? OR source_id=?").get(ids.report, ids.source)).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const tombstone = db.prepare("SELECT * FROM account_deletion_jobs WHERE id=?").get(jobId) as Record<string, unknown>;
    expect(tombstone.state).toBe("completed");
    expect(db.prepare("SELECT 1 FROM account_deletion_files WHERE job_id=?").get(jobId)).toBeUndefined();
    expect(JSON.stringify(tombstone)).not.toMatch(/delete-owner@nexus\.test|password-hash|session-token|ciphertext-must-disappear/i);
    const retainedAudit = db.prepare("SELECT user_id AS userId,metadata_json AS metadata FROM audit_events WHERE action='account.deleted' AND resource_id=?").get(jobId) as { userId: string | null; metadata: string };
    expect(retainedAudit.userId).toBeNull();
    expect(retainedAudit.metadata).not.toMatch(/email|password|ciphertext/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE user_id IS NULL AND metadata_json NOT IN ('{\"redactedForAccountDeletion\":true}') AND action<>'account.deleted'").get()).toEqual({ count: 0 });

    await expect(deleteOwnerAccount({ userId, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: key })).resolves.toEqual(getAccountDeletionJobForTests(jobId));

    const replacement = randomUUID();
    const replacementNow = new Date().toISOString();
    db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Replacement','replacement@nexus.test',0,?,?)").run(replacement, replacementNow, replacementNow);
    expect(() => db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Second','second@nexus.test',0,?,?)").run(randomUUID(), replacementNow, replacementNow)).toThrow(/one owner account/);
    await expect(deleteOwnerAccount({ userId: replacement, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: key })).rejects.toMatchObject({ code: "stale_completed_idempotency_key", status: 409 });

    const concurrentKey = randomUUID();
    const concurrent = await Promise.all([
      deleteOwnerAccount({ userId: replacement, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: concurrentKey }),
      deleteOwnerAccount({ userId: replacement, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: concurrentKey }),
    ]);
    expect(concurrent.map((item) => item.state)).toEqual(["completed", "completed"]);
    const concurrentTombstone = db.prepare("SELECT state,completed_at AS completedAt,sanitized_error AS error FROM account_deletion_jobs WHERE id=?").get(concurrent[0].jobId);
    expect(concurrentTombstone).toEqual({ state: "completed", completedAt: expect.any(String), error: null });

    const finalOwner = randomUUID();
    db.prepare("INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,'Final owner','final@nexus.test',0,?,?)").run(finalOwner, replacementNow, replacementNow);
  });
});


describe("owner quiescence", () => {
  it("aborts and drains active chat, research, root-agent, and delegated-agent operations before deleting credentials", async () => {
    const userId = getTestUser();
    const kinds = ["chat", "research", "agent", "delegated_agent"];
    const operations = kinds.map((kind) => beginOwnerOperation(userId, kind));
    const aborted: string[] = [];
    operations.forEach((operation, index) => operation.signal.addEventListener("abort", () => {
      aborted.push(kinds[index]!);
      setTimeout(operation.end, 5);
    }, { once: true }));
    const result = await deleteOwnerAccount({ userId, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: randomUUID() });
    expect(result.state).toBe("completed");
    expect(aborted.sort()).toEqual([...kinds].sort());
    expect(activeOwnerOperationCountForTests(userId)).toBe(0);
    expect(operations.every((operation) => operation.signal.aborted)).toBe(true);
    expect(getDb().prepare("SELECT 1 FROM provider_connections WHERE user_id=?").get(userId)).toBeUndefined();
    expect(getDb().prepare("SELECT 1 FROM user WHERE id=?").get(userId)).toBeUndefined();
  });
});


describe("production credential operation quiescence", () => {
  it("aborts and drains an in-flight GitHub write before deletion can complete", async () => {
    const db = getDb(); const userId = getTestUser(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO github_connections (id,user_id,connection_type,encrypted_token,status,created_at,updated_at)
      VALUES (?,?,'token',?,'connected',?,?)`).run(randomUUID(), userId, encryptSecret("github-token-for-quiescence"), now, now);
    const sha = "a".repeat(40); let postStarted!: () => void; const started = new Promise<void>((resolve) => { postStarted = resolve; }); let postCount = 0; let aborted = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? "GET";
      if (url === "https://api.github.com/repos/octo/example") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      if (url.endsWith("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha } }), { status: 200 });
      if (url.endsWith("/git/ref/heads/quiesce")) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      if (method === "POST") {
        postCount += 1; postStarted();
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); }, { once: true }));
      }
      return new Response(JSON.stringify({ message: "unexpected" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const write = createBranch(userId, "octo/example", { branch: "quiesce", base: "main", confirm: true, idempotencyKey: randomUUID() });
    await started;
    const deletion = deleteOwnerAccount({ userId, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: randomUUID() });
    await expect(write).rejects.toBeTruthy();
    await expect(deletion).resolves.toMatchObject({ state: "completed" });
    expect(postCount).toBe(1);
    expect(aborted).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
