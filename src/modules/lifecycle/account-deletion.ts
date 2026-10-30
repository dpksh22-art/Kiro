import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { ArtifactError, cleanupOwnerArtifactContent, type OwnerArtifactCleanupOptions, type OwnerArtifactCleanupResult } from "@/src/modules/artifacts/service";
import { clearOwnerQuiescenceIfSafe, quiesceOwner, waitForOwnerDrain } from "@/src/modules/lifecycle/owner-runtime";

export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY NEXUS ACCOUNT";

export type AccountDeletionState = "pending" | "deleting_files" | "completed" | "failed";
export type AccountDeletionResult = {
  jobId: string;
  state: AccountDeletionState;
  retryable: boolean;
  artifactCount: number;
  attachmentCount: number;
  uniquePathCount: number;
  removedPathCount: number;
  missingPathCount: number;
};

export class AccountDeletionError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) { super(message); }
}

type JobRow = {
  id: string;
  idempotencyKey: string;
  ownerUserIdHash: string;
  requestHash: string;
  state: AccountDeletionState;
  artifactCount: number;
  attachmentCount: number;
  uniquePathCount: number;
  removedPathCount: number;
  missingPathCount: number;
};

const OWNER_TABLES = [
  "provider_connections", "projects", "conversations", "attachments", "agents", "agent_teams", "task_runs", "artifacts",
  "tool_invocations", "research_sources", "research_reports", "github_connections", "budget_policies", "usage_records",
  "notifications", "idempotency_keys", "project_memories", "github_write_operations", "resource_budget_policies", "resource_usage_records", "owner_runtime_state",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ownerHash(userId: string): string {
  return sha256(`nexus-account-deletion-owner:v1:${userId}`);
}

function requestHash(userId: string, confirmation: string): string {
  return sha256(`nexus-account-deletion-request:v1:${userId}:${confirmation}`);
}

function readJob(id: string): JobRow {
  const row = getDb().prepare(`SELECT id,idempotency_key AS idempotencyKey,owner_user_id_hash AS ownerUserIdHash,request_hash AS requestHash,state,
    artifact_count AS artifactCount,attachment_count AS attachmentCount,unique_path_count AS uniquePathCount,
    removed_path_count AS removedPathCount,missing_path_count AS missingPathCount
    FROM account_deletion_jobs WHERE id=?`).get(id) as JobRow | undefined;
  if (!row) throw new AccountDeletionError("Account deletion job was not found.", 404, "job_not_found");
  return row;
}

function resultFromJob(job: JobRow): AccountDeletionResult {
  return {
    jobId: job.id,
    state: job.state,
    retryable: job.state === "failed" || job.state === "pending" || job.state === "deleting_files",
    artifactCount: job.artifactCount,
    attachmentCount: job.attachmentCount,
    uniquePathCount: job.uniquePathCount,
    removedPathCount: job.removedPathCount,
    missingPathCount: job.missingPathCount,
  };
}

function countOwnerRows(userId: string): number {
  const db = getDb();
  let total = 0;
  for (const table of OWNER_TABLES) {
    total += (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`).get(userId) as { count: number }).count;
  }
  total += (db.prepare("SELECT COUNT(*) AS count FROM account WHERE userId=?").get(userId) as { count: number }).count;
  total += (db.prepare("SELECT COUNT(*) AS count FROM session WHERE userId=?").get(userId) as { count: number }).count;
  return total;
}

function prepareJob(userId: string, confirmation: string, idempotencyKey: string): JobRow {
  const db = getDb();
  const expectedOwnerHash = ownerHash(userId);
  const expectedRequestHash = requestHash(userId, confirmation);
  const keyed = db.prepare(`SELECT id,idempotency_key AS idempotencyKey,owner_user_id_hash AS ownerUserIdHash,request_hash AS requestHash,state,
    artifact_count AS artifactCount,attachment_count AS attachmentCount,unique_path_count AS uniquePathCount,
    removed_path_count AS removedPathCount,missing_path_count AS missingPathCount FROM account_deletion_jobs WHERE idempotency_key=?`).get(idempotencyKey) as JobRow | undefined;
  if (keyed) {
    if (keyed.ownerUserIdHash !== expectedOwnerHash) {
      if (keyed.state === "completed") throw new AccountDeletionError("A completed deletion key from a previous owner cannot be reused.", 409, "stale_completed_idempotency_key");
      throw new AccountDeletionError("The idempotency key was already used for a different deletion request.", 409, "idempotency_conflict");
    }
    if (keyed.requestHash !== expectedRequestHash) {
      throw new AccountDeletionError("The idempotency key was already used for a different deletion request.", 409, "idempotency_conflict");
    }
    return keyed;
  }
  const ownerJob = db.prepare(`SELECT id,idempotency_key AS idempotencyKey,owner_user_id_hash AS ownerUserIdHash,request_hash AS requestHash,state,
    artifact_count AS artifactCount,attachment_count AS attachmentCount,unique_path_count AS uniquePathCount,
    removed_path_count AS removedPathCount,missing_path_count AS missingPathCount FROM account_deletion_jobs WHERE owner_user_id_hash=?`).get(expectedOwnerHash) as JobRow | undefined;
  if (ownerJob) throw new AccountDeletionError("Retry account deletion with the original idempotency key.", 409, "idempotency_change_conflict");
  if (!db.prepare("SELECT 1 FROM user WHERE id=?").get(userId)) throw new AccountDeletionError("The authenticated owner no longer exists.", 401, "owner_missing");
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO account_deletion_jobs
    (id,idempotency_key,owner_user_id_hash,request_hash,state,data_row_count,created_at,updated_at)
    VALUES (?,?,?,?, 'pending',?,?,?)`).run(id, idempotencyKey, expectedOwnerHash, expectedRequestHash, countOwnerRows(userId), now, now);
  return readJob(id);
}

function finalizeDeletion(userId: string, jobId: string, cleanup: OwnerArtifactCleanupResult): AccountDeletionResult {
  const db = getDb();
  db.transaction(() => {
    const incomplete = db.prepare("SELECT COUNT(*) AS count FROM account_deletion_files WHERE job_id=? AND state NOT IN ('removed','missing')").get(jobId) as { count: number };
    if (incomplete.count) throw new AccountDeletionError("Artifact cleanup is incomplete.", 409, "cleanup_incomplete");
    const user = db.prepare("SELECT email FROM user WHERE id=?").get(userId) as { email: string } | undefined;
    if (!user) throw new AccountDeletionError("The owner account no longer exists.", 409, "owner_missing");

    // These immediate RESTRICT joins link two independently cascading owner roots.
    db.prepare("DELETE FROM run_agent_participants WHERE run_id IN (SELECT id FROM task_runs WHERE user_id=?)").run(userId);
    db.prepare("DELETE FROM task_delegations WHERE run_id IN (SELECT id FROM task_runs WHERE user_id=?)").run(userId);
    db.prepare(`DELETE FROM research_report_sources
      WHERE report_id IN (SELECT id FROM research_reports WHERE user_id=?)
         OR source_id IN (SELECT id FROM research_sources WHERE user_id=?)`).run(userId, userId);
    db.prepare("DELETE FROM verification WHERE value IN (?,?) OR identifier IN (?,?)").run(userId, user.email, userId, user.email);

    // Retain event shape and timing, but remove owner-linked IDs and metadata before the user FK becomes null.
    db.prepare(`UPDATE audit_events SET resource_id=NULL,request_id=NULL,metadata_json='{"redactedForAccountDeletion":true}' WHERE user_id=?`).run(userId);
    writeAudit({
      userId,
      action: "account.deleted",
      resourceType: "account",
      resourceId: jobId,
      outcome: "success",
      metadata: {
        artifactCount: cleanup.artifactCount,
        attachmentCount: cleanup.attachmentCount,
        uniquePathCount: cleanup.uniquePathCount,
        removedPathCount: cleanup.removedPathCount,
        missingPathCount: cleanup.missingPathCount,
      },
    });
    const deleted = db.prepare("DELETE FROM user WHERE id=?").run(userId);
    if (deleted.changes !== 1) throw new AccountDeletionError("The owner account could not be deleted.", 409, "owner_delete_conflict");
    if (db.prepare("SELECT 1 FROM account WHERE userId=? UNION ALL SELECT 1 FROM session WHERE userId=? LIMIT 1").get(userId, userId)) {
      throw new AccountDeletionError("Authentication rows remain after account deletion.", 500, "auth_cleanup_failed");
    }
    const foreignKeyFailures = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyFailures.length) throw new AccountDeletionError("Foreign-key verification failed after account deletion.", 500, "foreign_key_check_failed");
    const completedAt = new Date().toISOString();
    db.prepare(`UPDATE account_deletion_jobs SET state='completed',artifact_count=?,attachment_count=?,unique_path_count=?,removed_path_count=?,missing_path_count=?,sanitized_error=NULL,updated_at=?,completed_at=? WHERE id=?`).run(
      cleanup.artifactCount, cleanup.attachmentCount, cleanup.uniquePathCount, cleanup.removedPathCount, cleanup.missingPathCount, completedAt, completedAt, jobId,
    );
    db.prepare("DELETE FROM account_deletion_files WHERE job_id=?").run(jobId);
  })();
  return resultFromJob(readJob(jobId));
}

function sanitizedFailure(error: unknown): string {
  if (error instanceof ArtifactError) return "Artifact cleanup failed safety validation or filesystem removal.";
  return "Account deletion did not complete; the owner account was retained for retry.";
}

export async function deleteOwnerAccount(input: {
  userId: string;
  confirmation: string;
  idempotencyKey: string;
  artifactOptions?: OwnerArtifactCleanupOptions;
}): Promise<AccountDeletionResult> {
  if (input.confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    throw new AccountDeletionError(`Type ${ACCOUNT_DELETION_CONFIRMATION} exactly.`, 400, "confirmation_mismatch");
  }
  const job = prepareJob(input.userId, input.confirmation, input.idempotencyKey);
  if (job.state === "completed") return resultFromJob(job);
  quiesceOwner(input.userId);
  try {
    if (!await waitForOwnerDrain(input.userId, 5_000)) {
      throw new AccountDeletionError("Active owner operations did not drain before the deletion deadline.", 503, "owner_drain_timeout");
    }
    return await cleanupOwnerArtifactContent({
      userId: input.userId,
      jobId: job.id,
      options: input.artifactOptions,
      onAlreadyCompleted: () => resultFromJob(readJob(job.id)),
      finalize: (cleanup) => finalizeDeletion(input.userId, job.id, cleanup),
    });
  } catch (error) {
    const current = readJob(job.id);
    if (current.state === "completed") return resultFromJob(current);
    getDb().prepare("UPDATE account_deletion_jobs SET state='failed',sanitized_error=?,updated_at=? WHERE id=?").run(
      sanitizedFailure(error).slice(0, 240), new Date().toISOString(), job.id,
    );
    const reactivated = clearOwnerQuiescenceIfSafe(input.userId);
    if (error instanceof AccountDeletionError) throw error;
    throw new AccountDeletionError(reactivated
      ? "Account deletion could not complete. Your account was retained and admissions were safely restored; retry with the same request."
      : "Account deletion could not complete. Your account remains quiesced for safe recovery; retry with the same request.", 503, "deletion_failed");
  }
}

export function getAccountDeletionJobForTests(jobId: string): AccountDeletionResult {
  return resultFromJob(readJob(jobId));
}

export async function recoverQuiescingDeletionJobs(): Promise<void> {
  const owners = getDb().prepare("SELECT user_id AS userId FROM owner_runtime_state WHERE state='quiescing'").all() as Array<{ userId: string }>;
  for (const owner of owners) {
    const job = getDb().prepare("SELECT idempotency_key AS idempotencyKey FROM account_deletion_jobs WHERE owner_user_id_hash=? AND state<>'completed'").get(ownerHash(owner.userId)) as { idempotencyKey: string } | undefined;
    if (!job) { clearOwnerQuiescenceIfSafe(owner.userId); continue; }
    await deleteOwnerAccount({ userId: owner.userId, confirmation: ACCOUNT_DELETION_CONFIRMATION, idempotencyKey: job.idempotencyKey }).catch(() => undefined);
  }
}
