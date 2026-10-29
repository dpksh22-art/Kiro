import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { getAdapter } from "@/src/modules/gateway/adapters";
import { releaseUsage, reserveUsage, settleUsage } from "@/src/modules/gateway/budgets";
import { connectionCredentials, getConnection } from "@/src/modules/gateway/connections";
import { addEvent } from "@/src/modules/agents/service";
import type { ChatTarget } from "@/src/modules/workspace/chat";

const activeControllers = new Map<string, AbortController>();
let polling = false;
let timer: ReturnType<typeof setInterval> | undefined;

type ClaimedTask = {
  id: string; runId: string; userId: string; projectId: string | null; title: string; taskType: string;
  inputJson: string; leaseToken: string; attemptNumber: number; attemptId: string; maxDurationSeconds: number; runDeadlineAt: string | null;
};

export function recoverExpired(): void {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db.prepare(`SELECT id, run_id AS runId, attempt_count AS attemptCount, max_attempts AS maxAttempts, status
    FROM tasks WHERE status IN ('leased','running','cancel_requested') AND lease_expires_at < ?`).all(now) as Array<{ id: string; runId: string; attemptCount: number; maxAttempts: number; status: string }>;
  db.transaction(() => {
    for (const task of expired) {
      const next = task.status === "cancel_requested" ? "cancelled" : task.attemptCount < task.maxAttempts ? "ready" : "failed";
      db.prepare(`UPDATE tasks SET status=?, lease_token=NULL, lease_expires_at=NULL, ready_at=?, error_code='lease_expired',
        error_message='Worker lease expired.', updated_at=?, completed_at=? WHERE id=?`).run(next, next === "ready" ? now : null, now, next === "ready" ? null : now, task.id);
      const attemptStatus = next === "cancelled" ? "cancelled" : "abandoned";
      db.prepare(`UPDATE task_attempts SET status=?, completed_at=?, error_code='lease_expired', error_message='Worker lease expired.'
        WHERE task_id=? AND attempt_number=? AND status='running'`).run(attemptStatus, now, task.id, task.attemptCount);
      db.prepare("UPDATE usage_records SET status='released', settled_at=? WHERE task_id=? AND status='reserved'").run(now, task.id);
      addEvent(db, task.runId, task.id, next === "ready" ? "TaskRecovered" : next === "cancelled" ? "TaskCancelled" : "TaskFailed", { reason: "lease_expired" });
    }
  })();
  for (const runId of new Set(expired.map((task) => task.runId))) refreshRun(runId);
}

function claimTask(): ClaimedTask | null {
  const db = getDb();
  const now = new Date();
  const leaseToken = randomUUID();
  const leaseExpires = new Date(now.getTime() + 45_000).toISOString();
  return db.transaction(() => {
    const candidate = db.prepare(`SELECT t.id, t.run_id AS runId, r.user_id AS userId, r.project_id AS projectId,
      t.title, t.task_type AS taskType, t.input_json AS inputJson, t.attempt_count AS attemptCount, r.max_parallelism AS maxParallelism,
      COALESCE(a.max_duration_seconds, 600) AS maxDurationSeconds, r.deadline_at AS runDeadlineAt
      FROM tasks t JOIN task_runs r ON r.id=t.run_id LEFT JOIN agents a ON a.id=t.assigned_agent_id
      WHERE t.status='ready' AND (t.ready_at IS NULL OR t.ready_at<=?) AND r.status='running'
      AND (SELECT count(*) FROM tasks active WHERE active.run_id=r.id AND active.status IN ('leased','running')) < r.max_parallelism
      ORDER BY t.priority DESC, t.ready_at, t.created_at LIMIT 1`).get(now.toISOString()) as Omit<ClaimedTask, "leaseToken" | "attemptNumber"> & { attemptCount: number } | undefined;
    if (!candidate) return null;
    const attemptNumber = candidate.attemptCount + 1;
    const attemptId = randomUUID();
    const changed = db.prepare(`UPDATE tasks SET status='leased', attempt_count=?, lease_token=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND status='ready'`).run(attemptNumber, leaseToken, leaseExpires, now.toISOString(), candidate.id);
    if (!changed.changes) return null;
    db.prepare(`INSERT INTO task_attempts (id, task_id, attempt_number, status, worker_id, lease_token, started_at, heartbeat_at)
      VALUES (?, ?, ?, 'running', 'embedded-worker', ?, ?, ?)`).run(attemptId, candidate.id, attemptNumber, leaseToken, now.toISOString(), now.toISOString());
    addEvent(db, candidate.runId, candidate.id, "AgentStarted", { attemptNumber });
    return { ...candidate, leaseToken, attemptNumber, attemptId };
  })();
}

function heartbeat(task: ClaimedTask): boolean {
  const now = new Date();
  const result = getDb().prepare(`UPDATE tasks SET status='running', lease_expires_at=?, updated_at=?
    WHERE id=? AND lease_token=? AND status IN ('leased','running')`).run(new Date(now.getTime() + 45_000).toISOString(), now.toISOString(), task.id, task.leaseToken);
  return result.changes === 1;
}

async function executeModelTask(task: ClaimedTask): Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number; billedCostMicros?: number; currency?: string }; provider: string; modelId: string; reservationId: string }> {
  const input = JSON.parse(task.inputJson) as { goal: string; instructions?: string; completionCriteria?: string; target: ChatTarget; mode?: string };
  const connection = getConnection(task.userId, input.target.connectionId);
  if (!connection) throw new Error("Provider connection not found.");
  let dependencyContext = "";
  if (task.taskType === "synthesis") {
    const dependencies = getDb().prepare(`SELECT t.title, t.status, t.output_json AS outputJson, t.error_message AS errorMessage
      FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=? ORDER BY t.created_at`).all(task.id) as Array<{ title: string; status: string; outputJson: string | null; errorMessage: string | null }>;
    dependencyContext = dependencies.map((item) => {
      const output = item.outputJson ? JSON.parse(item.outputJson) as { content?: string } : null;
      return `## ${item.title} (${item.status})\n${output?.content ?? item.errorMessage ?? "No output"}`;
    }).join("\n\n");
  }
  const system = task.taskType === "synthesis"
    ? "You are the final coordinator. Reconcile the independent work below. Preserve material disagreements, reject unsupported claims, verify the answer against the goal, and return one useful final deliverable followed by a brief limitations section."
    : `${input.instructions ?? "Complete the assigned task."}\nCompletion criteria: ${input.completionCriteria ?? "Produce a useful, verifiable result."}`;
  const user = task.taskType === "synthesis" ? `Original goal:\n${input.goal}\n\nIndependent outputs:\n${dependencyContext}` : input.goal;
  const pricing = getDb().prepare(`SELECT input_price_micros_per_million AS inputPrice, output_price_micros_per_million AS outputPrice, pricing_currency AS currency
    FROM models WHERE connection_id=? AND provider_model_id=?`).get(input.target.connectionId, input.target.modelId) as { inputPrice: number | null; outputPrice: number | null; currency: string | null } | undefined;
  const estimatedCostMicros = pricing?.inputPrice != null && pricing.outputPrice != null
    ? Math.ceil((Math.ceil((system.length + user.length) / 4) * pricing.inputPrice + 3000 * pricing.outputPrice) / 1_000_000)
    : undefined;
  const reservationId = reserveUsage({ userId: task.userId, projectId: task.projectId ?? undefined, runId: task.runId, taskId: task.id, attemptId: task.attemptId, provider: connection.provider, modelId: input.target.modelId, estimatedCostMicros, currency: pricing?.currency ?? undefined });
  const controller = new AbortController();
  activeControllers.set(task.id, controller);
  let content = "";
  let usage: { inputTokens?: number; outputTokens?: number; billedCostMicros?: number; currency?: string } | undefined;
  const agentDeadlineMs = Date.now() + task.maxDurationSeconds * 1000;
  const runDeadlineMs = task.runDeadlineAt ? new Date(task.runDeadlineAt).getTime() : Number.POSITIVE_INFINITY;
  const effectiveDeadlineMs = Math.min(agentDeadlineMs, runDeadlineMs);
  const deadlineMessage = runDeadlineMs <= agentDeadlineMs ? "Run deadline exceeded." : "Execution deadline exceeded.";
  let deadlineExceeded = false;
  const deadlineTimer = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(new Error(deadlineMessage));
  }, Math.max(0, effectiveDeadlineMs - Date.now()));
  deadlineTimer.unref?.();
  const heartbeatTimer = setInterval(() => {
    if (!heartbeat(task)) controller.abort();
    const state = getDb().prepare("SELECT status FROM tasks WHERE id=?").get(task.id) as { status: string } | undefined;
    if (state?.status === "cancel_requested") controller.abort();
  }, 10_000);
  heartbeatTimer.unref?.();
  try {
    for await (const event of getAdapter(connection.provider).stream({ modelId: input.target.modelId, messages: [{ role: "system", content: system }, { role: "user", content: user }], maxOutputTokens: 3000, signal: controller.signal }, connectionCredentials(connection))) {
      if (event.type === "content.delta") {
        content += event.text;
        if (content.length % 500 < event.text.length) addEvent(getDb(), task.runId, task.id, "AgentProgress", { characters: content.length });
      } else if ((event.type === "usage.updated" || event.type === "response.completed") && event.usage) usage = { ...usage, ...event.usage };
    }
    return { content, usage, provider: connection.provider, modelId: input.target.modelId, reservationId };
  } catch (error) {
    releaseUsage(reservationId);
    if (deadlineExceeded) throw new Error(deadlineMessage);
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(heartbeatTimer);
    activeControllers.delete(task.id);
  }
}

function refreshRun(runId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    const blocked = db.prepare("SELECT id FROM tasks WHERE run_id=? AND status='blocked'").all(runId) as Array<{ id: string }>;
    for (const task of blocked) {
      const pending = db.prepare(`SELECT count(*) AS count FROM task_dependencies d JOIN tasks p ON p.id=d.depends_on_task_id
        WHERE d.task_id=? AND p.status NOT IN ('succeeded','failed','cancelled','skipped')`).get(task.id) as { count: number };
      if (pending.count === 0) {
        db.prepare("UPDATE tasks SET status='ready', ready_at=?, updated_at=? WHERE id=? AND status='blocked'").run(now, now, task.id);
        addEvent(db, runId, task.id, "TaskReady", {});
      }
    }
    const run = db.prepare("SELECT status FROM task_runs WHERE id=?").get(runId) as { status: string } | undefined;
    const counts = db.prepare(`SELECT count(*) AS total,
      SUM(CASE WHEN status IN ('succeeded','failed','cancelled','skipped') THEN 1 ELSE 0 END) AS terminal,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM tasks WHERE run_id=?`).get(runId) as { total: number; terminal: number; failed: number };
    if (counts.total > 0 && counts.terminal === counts.total) {
      const finalStatus = run?.status === "cancel_requested" ? "cancelled" : counts.failed > 0 ? "failed" : "succeeded";
      db.prepare("UPDATE task_runs SET status=?, updated_at=?, completed_at=? WHERE id=?").run(finalStatus, now, now, runId);
      addEvent(db, runId, null, finalStatus === "succeeded" ? "TaskCompleted" : finalStatus === "cancelled" ? "TaskCancelled" : "TaskFailed", { status: finalStatus });
    }
  })();
}

async function execute(task: ClaimedTask): Promise<void> {
  const db = getDb();
  try {
    heartbeat(task);
    const result = await executeModelTask(task);
    const now = new Date().toISOString();
    db.transaction(() => {
      const changed = db.prepare(`UPDATE tasks SET status='succeeded', output_json=?, lease_token=NULL, lease_expires_at=NULL,
        updated_at=?, completed_at=? WHERE id=? AND lease_token=? AND status IN ('leased','running')`)
        .run(JSON.stringify({ content: result.content, provider: result.provider, modelId: result.modelId, usage: result.usage }), now, now, task.id, task.leaseToken);
      if (!changed.changes) throw new Error("Task lease was lost before completion.");
      db.prepare(`UPDATE task_attempts SET status='succeeded', completed_at=?, usage_json=?, result_json=?
        WHERE task_id=? AND attempt_number=?`).run(now, JSON.stringify(result.usage ?? {}), JSON.stringify({ characters: result.content.length }), task.id, task.attemptNumber);
      settleUsage(result.reservationId, result.usage ?? {});
      addEvent(db, task.runId, task.id, "ArtifactProduced", { characters: result.content.length });
      addEvent(db, task.runId, task.id, "TaskCompleted", {});
    })();
  } catch (error) {
    const now = new Date().toISOString();
    const state = db.prepare("SELECT status, attempt_count AS attempts, max_attempts AS maxAttempts FROM tasks WHERE id=?").get(task.id) as { status: string; attempts: number; maxAttempts: number };
    const cancelled = state.status === "cancel_requested";
    const timedOut = error instanceof Error && (error.message === "Execution deadline exceeded." || error.message === "Run deadline exceeded.");
    const retry = !cancelled && !timedOut && state.attempts < state.maxAttempts;
    const status = cancelled ? "cancelled" : retry ? "retry_wait" : "failed";
    const message = error instanceof Error ? error.message.slice(0, 1_000) : "Task execution failed.";
    const errorCode = cancelled ? "cancelled" : timedOut ? "deadline_exceeded" : "execution_failed";
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET status=?, ready_at=?, lease_token=NULL, lease_expires_at=NULL, error_code=?, error_message=?, updated_at=?, completed_at=?
        WHERE id=? AND lease_token=?`).run(status, retry ? new Date(Date.now() + 2_000 * 2 ** state.attempts).toISOString() : null, errorCode, message, now, retry ? null : now, task.id, task.leaseToken);
      const attemptStatus = retry ? "failed" : status;
      db.prepare("UPDATE task_attempts SET status=?, completed_at=?, error_code=?, error_message=? WHERE task_id=? AND attempt_number=?")
        .run(attemptStatus, now, errorCode, message, task.id, task.attemptNumber);
      addEvent(db, task.runId, task.id, retry ? "TaskRetryScheduled" : cancelled ? "TaskCancelled" : "TaskFailed", { message, attempt: state.attempts });
    })();
  } finally {
    refreshRun(task.runId);
  }
}

export function expireRunDeadlines(): void {
  const db = getDb();
  const now = new Date().toISOString();
  const runs = db.prepare(`SELECT id FROM task_runs WHERE status IN ('pending','running','waiting','paused') AND deadline_at IS NOT NULL AND deadline_at<=?`).all(now) as Array<{ id: string }>;
  db.transaction(() => {
    for (const run of runs) {
      const active = db.prepare("SELECT id FROM tasks WHERE run_id=? AND status IN ('leased','running','cancel_requested')").all(run.id) as Array<{ id: string }>;
      for (const task of active) activeControllers.get(task.id)?.abort(new Error("Run deadline exceeded."));
      db.prepare(`UPDATE tasks SET status='failed', error_code='deadline_exceeded', error_message='Run deadline exceeded.', lease_token=NULL,
        lease_expires_at=NULL, updated_at=?, completed_at=? WHERE run_id=? AND status NOT IN ('succeeded','failed','cancelled','skipped')`).run(now, now, run.id);
      db.prepare(`UPDATE task_attempts SET status='failed', error_code='deadline_exceeded', error_message='Run deadline exceeded.', completed_at=?
        WHERE task_id IN (SELECT id FROM tasks WHERE run_id=?) AND status='running'`).run(now, run.id);
      db.prepare("UPDATE usage_records SET status='released', settled_at=? WHERE run_id=? AND status='reserved'").run(now, run.id);
      db.prepare("UPDATE task_runs SET status='failed', updated_at=?, completed_at=? WHERE id=?").run(now, now, run.id);
      addEvent(db, run.id, null, "RunDeadlineExceeded", {});
    }
  })();
}

export async function workerTick(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    expireRunDeadlines();
    recoverExpired();
    const claimed: ClaimedTask[] = [];
    for (let index = 0; index < 8; index += 1) {
      const task = claimTask();
      if (!task) break;
      claimed.push(task);
    }
    await Promise.allSettled(claimed.map(execute));
    getDb().prepare(`UPDATE tasks SET status='ready', ready_at=?, updated_at=? WHERE status='retry_wait' AND ready_at<=?`).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  } finally {
    polling = false;
  }
}

export function startEmbeddedWorker(): void {
  if (timer) return;
  const tick = () => void workerTick().catch((error) => console.error("Embedded worker tick failed", error));
  timer = setInterval(tick, 1_000);
  timer.unref?.();
  tick();
}

export function abortRun(runId: string): void {
  const rows = getDb().prepare("SELECT id FROM tasks WHERE run_id=? AND status='cancel_requested'").all(runId) as Array<{ id: string }>;
  for (const row of rows) activeControllers.get(row.id)?.abort();
}
