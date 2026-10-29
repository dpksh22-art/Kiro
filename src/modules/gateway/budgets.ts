import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { GatewayError } from "@/src/modules/gateway/errors";
import type { Usage } from "@/src/modules/gateway/types";

export type UsageReservationInput = {
  userId: string;
  projectId?: string;
  runId?: string;
  messageId?: string;
  taskId?: string;
  attemptId?: string;
  provider: string;
  modelId: string;
  estimatedCostMicros?: number;
  currency?: string;
};

export function reserveUsage(input: UsageReservationInput): string {
  const db = getDb();
  return db.transaction(() => {
    const policies = db.prepare(`SELECT hard_limit_micros AS hardLimit, period, project_id AS projectId, provider
      FROM budget_policies WHERE user_id=? AND (provider IS NULL OR provider=?) AND (project_id IS NULL OR project_id=?)`)
      .all(input.userId, input.provider, input.projectId ?? null) as Array<{ hardLimit: number; period: string; projectId: string | null; provider: string | null }>;
    if (policies.length > 0 && input.currency !== "USD") {
      throw new GatewayError("budget_exceeded", "Beta monetary budgets require documented USD pricing.", 402);
    }
    if (policies.length > 0 && input.estimatedCostMicros === undefined) {
      throw new GatewayError("budget_exceeded", "A hard monetary budget is active, but this model has no verified price.", 402);
    }
    const now = new Date();
    for (const policy of policies) {
      const start = policy.period === "monthly"
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
        : policy.period === "daily"
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
          : "1970-01-01T00:00:00.000Z";
      const taskClause = policy.period === "task" ? (input.taskId ? "AND task_id=@taskId" : "AND message_id=@messageId") : "";
      const projectClause = policy.projectId ? "AND project_id=@projectId" : "";
      const providerClause = policy.provider ? "AND provider=@provider" : "";
      const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(billed_cost_micros, estimated_cost_micros)), 0) AS spent
        FROM usage_records WHERE user_id=@userId AND created_at>=@start
        AND status IN ('reserved','settled') ${providerClause} ${taskClause} ${projectClause}`).get({ ...input, start }) as { spent: number };
      if (row.spent + (input.estimatedCostMicros ?? 0) > policy.hardLimit) {
        throw new GatewayError("budget_exceeded", "The configured spending limit would be exceeded.", 402);
      }
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO usage_records
      (id, user_id, project_id, run_id, message_id, task_id, attempt_id, provider, model_id, estimated_cost_micros, currency, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`)
      .run(id, input.userId, input.projectId ?? null, input.runId ?? null, input.messageId ?? null, input.taskId ?? null, input.attemptId ?? null, input.provider, input.modelId,
        input.estimatedCostMicros ?? null, input.currency ?? null, now.toISOString());
    return id;
  })();
}

export function settleUsage(id: string, usage: Usage): void {
  if (usage.currency && usage.currency !== "USD") throw new GatewayError("provider_error", "Beta monetary accounting accepts USD only.");
  getDb().prepare(`UPDATE usage_records SET input_tokens=?, output_tokens=?, billed_cost_micros=?, currency=COALESCE(?,currency),
    status='settled', settled_at=? WHERE id=? AND status='reserved'`)
    .run(usage.inputTokens ?? null, usage.outputTokens ?? null, usage.billedCostMicros ?? null, usage.currency ?? null, new Date().toISOString(), id);
}

export function releaseUsage(id: string): void {
  getDb().prepare("UPDATE usage_records SET status='released', settled_at=? WHERE id=? AND status='reserved'").run(new Date().toISOString(), id);
}

export function assertBudget(userId: string, provider: string, estimatedCostMicros?: number): void {
  const policies = getDb().prepare("SELECT 1 FROM budget_policies WHERE user_id=? AND (provider IS NULL OR provider=?) LIMIT 1").get(userId, provider);
  if (policies && estimatedCostMicros === undefined) throw new GatewayError("budget_exceeded", "A hard monetary budget is active, but this model has no verified price.", 402);
}
