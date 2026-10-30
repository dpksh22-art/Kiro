import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/src/core/database";
import { GatewayError } from "@/src/modules/gateway/errors";
import type { Usage } from "@/src/modules/gateway/types";

export const RESOURCE_UNITS = ["model_calls", "input_tokens", "output_tokens", "tool_calls", "task_starts"] as const;
export type ResourceUnit = (typeof RESOURCE_UNITS)[number];

const optionalCap = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
export const agentBudgetSchema = z.object({
  perRun: z.object({
    modelCalls: optionalCap,
    outputTokens: optionalCap,
    toolCalls: optionalCap,
  }).strict().default({}),
}).strict().default({ perRun: {} });
export type AgentBudget = z.infer<typeof agentBudgetSchema>;

export function normalizeAgentBudget(value: unknown): AgentBudget {
  return agentBudgetSchema.parse(value ?? {});
}

export type ResourceReservationInput = {
  userId: string;
  projectId?: string;
  provider?: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  attemptId?: string;
  messageId?: string;
  researchReportId?: string;
  usageRecordId?: string;
  toolInvocationId?: string;
  modelId?: string;
  toolName?: string;
  resources: Partial<Record<ResourceUnit, number>>;
  agentBudget?: AgentBudget;
  reservationExpiresAt?: string;
  now?: Date;
};

export type UsageReservationInput = {
  userId: string;
  projectId?: string;
  runId?: string;
  agentId?: string;
  messageId?: string;
  taskId?: string;
  attemptId?: string;
  researchReportId?: string;
  provider: string;
  modelId: string;
  estimatedCostMicros?: number;
  currency?: string;
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  agentBudget?: AgentBudget;
  reservationExpiresAt?: string;
  now?: Date;
};

type ResourcePolicy = {
  hardLimit: number;
  unit: ResourceUnit;
  period: "task" | "run" | "daily" | "monthly";
  scopeType: "owner" | "project" | "provider" | "run" | "agent";
  projectId: string | null;
  provider: string | null;
  runId: string | null;
  agentId: string | null;
};

function assertUnits(resources: Partial<Record<ResourceUnit, number>>): Array<[ResourceUnit, number]> {
  return Object.entries(resources).map(([unit, amount]) => {
    if (!(RESOURCE_UNITS as readonly string[]).includes(unit) || !Number.isSafeInteger(amount) || Number(amount) < 0) {
      throw new GatewayError("request_invalid", "Resource reservation units must be non-negative safe integers.", 400);
    }
    return [unit as ResourceUnit, Number(amount)];
  });
}

function periodStart(period: ResourcePolicy["period"] | "task", now: Date): string {
  if (period === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  if (period === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return "1970-01-01T00:00:00.000Z";
}

function contextClause(period: ResourcePolicy["period"], input: ResourceReservationInput): { sql: string; applicable: boolean } {
  if (period === "run") return { sql: "AND run_id=@runId", applicable: Boolean(input.runId) };
  if (period !== "task") return { sql: "", applicable: true };
  if (input.taskId) return { sql: "AND task_id=@taskId", applicable: true };
  if (input.messageId) return { sql: "AND message_id=@messageId", applicable: true };
  if (input.researchReportId) return { sql: "AND research_report_id=@researchReportId", applicable: true };
  return { sql: "", applicable: false };
}

function scopeClause(policy: ResourcePolicy): string {
  if (policy.scopeType === "project") return "AND project_id=@projectId";
  if (policy.scopeType === "provider") return "AND provider=@provider";
  if (policy.scopeType === "run") return "AND run_id=@runId";
  if (policy.scopeType === "agent") return "AND agent_id=@agentId";
  return "";
}

function resourceValueSql(): string {
  return "CASE WHEN status='reserved' THEN reserved_units ELSE COALESCE(consumed_units,reserved_units) END";
}

function matchingPolicies(input: ResourceReservationInput, unit: ResourceUnit): ResourcePolicy[] {
  return getDb().prepare(`SELECT hard_limit AS hardLimit,unit,period,scope_type AS scopeType,project_id AS projectId,provider,run_id AS runId,agent_id AS agentId
    FROM resource_budget_policies WHERE user_id=@userId AND unit=@unit AND (
      scope_type='owner' OR (scope_type='project' AND project_id=@projectId) OR
      (scope_type='provider' AND provider=@provider) OR (scope_type='run' AND run_id=@runId) OR
      (scope_type='agent' AND agent_id=@agentId))`).all({
        userId: input.userId, unit, projectId: input.projectId ?? null, provider: input.provider ?? null,
        runId: input.runId ?? null, agentId: input.agentId ?? null,
      }) as ResourcePolicy[];
}

function assertResourceAdmission(input: ResourceReservationInput, entries: Array<[ResourceUnit, number]>, now: Date): void {
  const db = getDb();
  for (const [unit, amount] of entries) {
    for (const policy of matchingPolicies(input, unit)) {
      const context = contextClause(policy.period, input);
      if (!context.applicable) continue;
      const row = db.prepare(`SELECT COALESCE(SUM(${resourceValueSql()}),0) AS used FROM resource_usage_records
        WHERE user_id=@userId AND unit=@unit AND status IN ('reserved','consumed') AND created_at>=@start
        ${scopeClause(policy)} ${context.sql}`).get({ ...input, unit, start: periodStart(policy.period, now) }) as { used: number };
      if (row.used + amount > policy.hardLimit) {
        throw new GatewayError("budget_exceeded", `The ${unit} resource budget would be exceeded.`, 402);
      }
    }

    const perRun = input.agentBudget?.perRun;
    const cap = unit === "model_calls" ? perRun?.modelCalls : unit === "output_tokens" ? perRun?.outputTokens : unit === "tool_calls" ? perRun?.toolCalls : undefined;
    if (cap !== undefined && input.runId && input.agentId) {
      const row = db.prepare(`SELECT COALESCE(SUM(${resourceValueSql()}),0) AS used FROM resource_usage_records
        WHERE user_id=? AND run_id=? AND agent_id=? AND unit=? AND status IN ('reserved','consumed')`)
        .get(input.userId, input.runId, input.agentId, unit) as { used: number };
      if (row.used + amount > cap) throw new GatewayError("budget_exceeded", `The agent per-run ${unit} cap would be exceeded.`, 402);
    }
  }
}

function insertResourceReservations(input: ResourceReservationInput, now: Date): string[] {
  const entries = assertUnits(input.resources);
  assertResourceAdmission(input, entries, now);
  const groupId = randomUUID();
  const insert = getDb().prepare(`INSERT INTO resource_usage_records
    (id,reservation_group_id,user_id,project_id,provider,run_id,agent_id,task_id,attempt_id,message_id,research_report_id,
     usage_record_id,tool_invocation_id,model_id,tool_name,unit,reserved_units,status,created_at,reservation_expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`);
  return entries.map(([unit, amount]) => {
    const id = randomUUID();
    insert.run(id, groupId, input.userId, input.projectId ?? null, input.provider ?? null, input.runId ?? null,
      input.agentId ?? null, input.taskId ?? null, input.attemptId ?? null, input.messageId ?? null,
      input.researchReportId ?? null, input.usageRecordId ?? null, input.toolInvocationId ?? null,
      input.modelId ?? null, input.toolName ?? null, unit, amount, now.toISOString(), input.reservationExpiresAt ?? null);
    return id;
  });
}

export function recoverExpiredBudgetReservations(at = new Date()): number {
  const db = getDb();
  return db.transaction(() => {
    const timestamp = at.toISOString();
    const expired = db.prepare(`SELECT id,dispatched_at AS dispatchedAt FROM usage_records
      WHERE status='reserved' AND reservation_expires_at IS NOT NULL AND reservation_expires_at<=?`).all(timestamp) as Array<{ id: string; dispatchedAt: string | null }>;
    for (const row of expired) {
      if (row.dispatchedAt) consumeUnknownUsageInTransaction(row.id, at);
      else releaseUsageInTransaction(row.id, at);
    }
    const standalone = db.prepare(`UPDATE resource_usage_records SET status='released',settled_at=?
      WHERE status='reserved' AND usage_record_id IS NULL AND reservation_expires_at IS NOT NULL AND reservation_expires_at<=?`).run(timestamp, timestamp).changes;
    return expired.length + standalone;
  })();
}

export function reserveResourceUsage(input: ResourceReservationInput): string[] {
  const db = getDb();
  return db.transaction(() => {
    const now = input.now ?? new Date();
    recoverExpiredBudgetReservations(now);
    return insertResourceReservations(input, now);
  })();
}

export function consumeResourceReservations(ids: string[], actual: Partial<Record<ResourceUnit, number>> = {}, settledAt = new Date()): void {
  if (!ids.length) return;
  const db = getDb();
  db.transaction(() => {
    const get = db.prepare("SELECT unit,reserved_units AS reservedUnits FROM resource_usage_records WHERE id=? AND status='reserved'");
    const update = db.prepare("UPDATE resource_usage_records SET consumed_units=?,status='consumed',settled_at=? WHERE id=? AND status='reserved'");
    for (const id of ids) {
      const row = get.get(id) as { unit: ResourceUnit; reservedUnits: number } | undefined;
      if (!row) continue;
      const value = actual[row.unit] ?? row.reservedUnits;
      if (!Number.isSafeInteger(value) || value < 0) throw new GatewayError("provider_error", "Provider returned invalid resource usage.");
      update.run(value, settledAt.toISOString(), id);
    }
  })();
}

export function releaseResourceReservations(ids: string[], settledAt = new Date()): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  getDb().prepare(`UPDATE resource_usage_records SET status='released',settled_at=? WHERE status='reserved' AND id IN (${placeholders})`)
    .run(settledAt.toISOString(), ...ids);
}

export function reserveUsage(input: UsageReservationInput): string {
  const db = getDb();
  return db.transaction(() => {
    const now = input.now ?? new Date();
    recoverExpiredBudgetReservations(now);
    const policies = db.prepare(`SELECT hard_limit_micros AS hardLimit, period, project_id AS projectId, provider
      FROM budget_policies WHERE user_id=? AND (provider IS NULL OR provider=?) AND (project_id IS NULL OR project_id=?)`)
      .all(input.userId, input.provider, input.projectId ?? null) as Array<{ hardLimit: number; period: "task" | "daily" | "monthly"; projectId: string | null; provider: string | null }>;
    if (policies.length > 0 && input.currency !== "USD") {
      throw new GatewayError("budget_exceeded", "Beta monetary budgets require documented USD pricing.", 402);
    }
    if (policies.length > 0 && input.estimatedCostMicros === undefined) {
      throw new GatewayError("budget_exceeded", "A hard monetary budget is active, but this model has no verified price.", 402);
    }
    for (const policy of policies) {
      const taskClause = policy.period === "task"
        ? input.taskId ? "AND task_id=@taskId"
          : input.messageId ? "AND message_id=@messageId"
            : input.researchReportId ? "AND research_report_id=@researchReportId"
              : "AND 1=0"
        : "";
      const projectClause = policy.projectId ? "AND project_id=@projectId" : "";
      const providerClause = policy.provider ? "AND provider=@provider" : "";
      const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(billed_cost_micros, estimated_cost_micros)), 0) AS spent
        FROM usage_records WHERE user_id=@userId AND created_at>=@start
        AND status IN ('reserved','settled') ${providerClause} ${taskClause} ${projectClause}`)
        .get({ ...input, start: periodStart(policy.period, now) }) as { spent: number };
      if (row.spent + (input.estimatedCostMicros ?? 0) > policy.hardLimit) {
        throw new GatewayError("budget_exceeded", "The configured spending limit would be exceeded.", 402);
      }
    }

    const id = randomUUID();
    const expiresAt = input.reservationExpiresAt ?? new Date(now.getTime() + 15 * 60_000).toISOString();
    const resourceInput: ResourceReservationInput = {
      ...input,
      usageRecordId: id,
      resources: {
        model_calls: 1,
        input_tokens: input.estimatedInputTokens ?? 0,
        output_tokens: input.maxOutputTokens ?? 0,
      },
      reservationExpiresAt: expiresAt,
    };
    const entries = assertUnits(resourceInput.resources);
    assertResourceAdmission(resourceInput, entries, now);

    db.prepare(`INSERT INTO usage_records
      (id,user_id,project_id,run_id,message_id,task_id,attempt_id,research_report_id,provider,model_id,estimated_cost_micros,currency,status,created_at,reservation_expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'reserved',?,?)`)
      .run(id, input.userId, input.projectId ?? null, input.runId ?? null, input.messageId ?? null, input.taskId ?? null,
        input.attemptId ?? null, input.researchReportId ?? null, input.provider, input.modelId,
        input.estimatedCostMicros ?? null, input.currency ?? null, now.toISOString(), expiresAt);
    insertResourceReservations(resourceInput, now);
    return id;
  })();
}

export function dispatchUsage(id: string, dispatchedAt = new Date()): void {
  const db = getDb();
  db.transaction(() => {
    const timestamp = dispatchedAt.toISOString();
    db.prepare("UPDATE usage_records SET dispatched_at=COALESCE(dispatched_at,?) WHERE id=? AND status='reserved'").run(timestamp, id);
    const calls = db.prepare("SELECT id FROM resource_usage_records WHERE usage_record_id=? AND unit='model_calls' AND status='reserved'").all(id) as Array<{ id: string }>;
    consumeResourceReservations(calls.map((row) => row.id), { model_calls: 1 }, dispatchedAt);
  })();
}

function consumeUnknownUsageInTransaction(id: string, settledAt = new Date()): void {
  const db = getDb();
  const reserved = db.prepare("SELECT id,unit,reserved_units AS reservedUnits FROM resource_usage_records WHERE usage_record_id=? AND status='reserved'").all(id) as Array<{ id: string; unit: ResourceUnit; reservedUnits: number }>;
  const input = reserved.find((row) => row.unit === "input_tokens")?.reservedUnits;
  const output = reserved.find((row) => row.unit === "output_tokens")?.reservedUnits;
  db.prepare(`UPDATE usage_records SET input_tokens=COALESCE(input_tokens,?),output_tokens=COALESCE(output_tokens,?),
    billed_cost_micros=COALESCE(billed_cost_micros,estimated_cost_micros),status='settled',accounting_outcome='unknown',settled_at=?
    WHERE id=? AND status='reserved' AND dispatched_at IS NOT NULL`).run(input ?? null, output ?? null, settledAt.toISOString(), id);
  consumeResourceReservations(reserved.map((row) => row.id), {}, settledAt);
}

function releaseUsageInTransaction(id: string, settledAt = new Date()): void {
  const db = getDb();
  db.prepare("UPDATE usage_records SET status='released',accounting_outcome='released',settled_at=? WHERE id=? AND status='reserved' AND dispatched_at IS NULL")
    .run(settledAt.toISOString(), id);
  const rows = db.prepare(`SELECT r.id FROM resource_usage_records r JOIN usage_records u ON u.id=r.usage_record_id
    WHERE r.usage_record_id=? AND r.status='reserved' AND u.dispatched_at IS NULL`).all(id) as Array<{ id: string }>;
  releaseResourceReservations(rows.map((row) => row.id), settledAt);
}

export function settleUsage(id: string, usage: Usage): void {
  if (usage.currency && usage.currency !== "USD") throw new GatewayError("provider_error", "Beta monetary accounting accepts USD only.");
  const db = getDb();
  db.transaction(() => {
    const now = new Date();
    db.prepare(`UPDATE usage_records SET input_tokens=?,output_tokens=?,billed_cost_micros=?,currency=COALESCE(?,currency),
      status='settled',accounting_outcome='completed',settled_at=? WHERE id=? AND status='reserved'`)
      .run(usage.inputTokens ?? null, usage.outputTokens ?? null, usage.billedCostMicros ?? null, usage.currency ?? null, now.toISOString(), id);
    const rows = db.prepare("SELECT id FROM resource_usage_records WHERE usage_record_id=? AND status='reserved'").all(id) as Array<{ id: string }>;
    consumeResourceReservations(rows.map((row) => row.id), {
      model_calls: 1,
      ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
    }, now);
  })();
}

export function releaseUsage(id: string): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT dispatched_at AS dispatchedAt FROM usage_records WHERE id=? AND status='reserved'").get(id) as { dispatchedAt: string | null } | undefined;
    if (!row) return;
    if (row.dispatchedAt) consumeUnknownUsageInTransaction(id);
    else releaseUsageInTransaction(id);
  })();
}

export function assertBudget(userId: string, provider: string, estimatedCostMicros?: number): void {
  const policies = getDb().prepare("SELECT 1 FROM budget_policies WHERE user_id=? AND (provider IS NULL OR provider=?) LIMIT 1").get(userId, provider);
  if (policies && estimatedCostMicros === undefined) throw new GatewayError("budget_exceeded", "A hard monetary budget is active, but this model has no verified price.", 402);
}
