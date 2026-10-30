import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestUser } from "@/tests/helpers";
import { getDb } from "@/src/core/database";
import {
  assertBudget, consumeResourceReservations, dispatchUsage, recoverExpiredBudgetReservations, releaseResourceReservations,
  releaseUsage, reserveResourceUsage, reserveUsage, settleUsage, type ResourceUnit,
} from "@/src/modules/gateway/budgets";
import { createProject, dashboard } from "@/src/modules/workspace/service";
import { createAgent } from "@/src/modules/agents/service";
import { GatewayError } from "@/src/modules/gateway/errors";

const policyIds: string[] = [];
const reservationIds: string[] = [];

function policy(input: {
  userId: string; unit: ResourceUnit; hardLimit: number; period?: "task" | "run" | "daily" | "monthly";
  scope?: "owner" | "project" | "provider" | "run" | "agent"; projectId?: string; provider?: string; runId?: string; agentId?: string;
}) {
  const id = randomUUID(); const now = new Date().toISOString(); policyIds.push(id);
  getDb().prepare(`INSERT INTO resource_budget_policies
    (id,user_id,unit,scope_type,project_id,provider,run_id,agent_id,period,hard_limit,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.userId, input.unit, input.scope ?? "owner", input.projectId ?? null,
      input.provider ?? null, input.runId ?? null, input.agentId ?? null, input.period ?? "daily", input.hardLimit, now, now);
  return id;
}

function reserve(input: Parameters<typeof reserveResourceUsage>[0]) {
  const ids = reserveResourceUsage(input); reservationIds.push(...ids); return ids;
}

function runContext(userId: string, projectId: string) {
  const db = getDb(); const runId = randomUUID(); const now = new Date().toISOString();
  const agentId = createAgent(userId, { name: `Budget ${randomUUID()}`, role: "budget", instructions: "budget" });
  db.prepare(`INSERT INTO task_runs (id,user_id,project_id,title,goal,mode,status,created_at,updated_at)
    VALUES (?,?,?,'budget','budget','team','running',?,?)`).run(runId, userId, projectId, now, now);
  return { runId, agentId };
}

beforeEach(() => {
  getDb().prepare("DELETE FROM resource_usage_records").run();
});

afterEach(() => {
  if (reservationIds.length) {
    releaseResourceReservations(reservationIds.splice(0));
  }
  for (const id of policyIds.splice(0)) getDb().prepare("DELETE FROM resource_budget_policies WHERE id=?").run(id);
});

describe("backend budget enforcement", () => {
  it("fails closed when a monetary policy exists and pricing is unknown", () => {
    const db = getDb(); const userId = getTestUser(); const now = new Date().toISOString(); const policyId = randomUUID();
    db.prepare(`INSERT INTO budget_policies (id,user_id,provider,period,hard_limit_micros,behavior,created_at,updated_at) VALUES (?,?,?,'daily',1000000,'stop',?,?)`).run(policyId, userId, "openai", now, now);
    expect(() => assertBudget(userId, "openai", undefined)).toThrow(/no verified price/i);
    expect(() => assertBudget(userId, "openai", 500_000)).not.toThrow();
    db.prepare("DELETE FROM budget_policies WHERE id=?").run(policyId);
  });

  it("aggregates a global monetary policy across providers", () => {
    const db = getDb(); const userId = getTestUser(); const now = new Date().toISOString(); const policyId = randomUUID();
    db.prepare(`INSERT INTO budget_policies (id,user_id,provider,period,hard_limit_micros,behavior,created_at,updated_at) VALUES (?,?,NULL,'daily',100,'stop',?,?)`).run(policyId, userId, now, now);
    const reservation = reserveUsage({ userId, provider: "openai", modelId: "a", estimatedCostMicros: 60, currency: "USD" });
    expect(() => reserveUsage({ userId, provider: "anthropic", modelId: "b", estimatedCostMicros: 60, currency: "USD" })).toThrow(/spending limit/i);
    releaseUsage(reservation);
    db.prepare("DELETE FROM budget_policies WHERE id=?").run(policyId);
  });

  it("atomically admits only the available parallel capacity", async () => {
    const userId = getTestUser(); policy({ userId, unit: "model_calls", hardLimit: 3 });
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, async () => reserve({ userId, provider: "openai", resources: { model_calls: 1 } })));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(9);
    expect(getDb().prepare("SELECT count(*) AS count FROM resource_usage_records WHERE user_id=? AND unit='model_calls' AND status='reserved'").get(userId)).toEqual({ count: 3 });
  });

  it("enforces owner, provider, project, run, and agent scopes independently", () => {
    const userId = getTestUser(); const firstProject = createProject(userId, `Budget one ${randomUUID()}`); const secondProject = createProject(userId, `Budget two ${randomUUID()}`);
    const first = runContext(userId, firstProject); const second = runContext(userId, secondProject);
    policy({ userId, unit: "input_tokens", scope: "owner", hardLimit: 10 });
    policy({ userId, unit: "model_calls", scope: "provider", provider: "openai", hardLimit: 1 });
    policy({ userId, unit: "output_tokens", scope: "project", projectId: firstProject, hardLimit: 5 });
    policy({ userId, unit: "tool_calls", scope: "run", runId: first.runId, hardLimit: 1, period: "run" });
    policy({ userId, unit: "task_starts", scope: "agent", agentId: first.agentId, hardLimit: 1, period: "daily" });
    reserve({ userId, projectId: firstProject, provider: "openai", runId: first.runId, agentId: first.agentId,
      resources: { input_tokens: 10, model_calls: 1, output_tokens: 5, tool_calls: 1, task_starts: 1 } });
    expect(() => reserve({ userId, projectId: secondProject, provider: "anthropic", runId: second.runId, agentId: second.agentId, resources: { input_tokens: 1 } })).toThrow(/input_tokens/);
    expect(() => reserve({ userId, projectId: secondProject, provider: "openai", runId: second.runId, agentId: second.agentId, resources: { model_calls: 1 } })).toThrow(/model_calls/);
    expect(() => reserve({ userId, projectId: firstProject, provider: "anthropic", runId: second.runId, agentId: second.agentId, resources: { output_tokens: 1 } })).toThrow(/output_tokens/);
    expect(() => reserve({ userId, projectId: secondProject, provider: "anthropic", runId: first.runId, agentId: second.agentId, resources: { tool_calls: 1 } })).toThrow(/tool_calls/);
    expect(() => reserve({ userId, projectId: secondProject, provider: "anthropic", runId: second.runId, agentId: first.agentId, resources: { task_starts: 1 } })).toThrow(/task_starts/);
    expect(() => reserve({ userId, projectId: secondProject, provider: "anthropic", runId: second.runId, agentId: second.agentId, resources: { output_tokens: 100, tool_calls: 100, task_starts: 100 } })).not.toThrow();
  });

  it("uses UTC daily and monthly boundaries and task/run partition keys", () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Periods ${randomUUID()}`); const { runId } = runContext(userId, projectId);
    const taskA = randomUUID(); const taskB = randomUUID(); const now = "2026-01-31T23:59:59.000Z";
    getDb().prepare(`INSERT INTO tasks (id,run_id,task_key,title,description,task_type,status,created_at,updated_at) VALUES (?,?,?,'a','a','model_agent','ready',?,?)`).run(taskA, runId, taskA, now, now);
    getDb().prepare(`INSERT INTO tasks (id,run_id,task_key,title,description,task_type,status,created_at,updated_at) VALUES (?,?,?,'b','b','model_agent','ready',?,?)`).run(taskB, runId, taskB, now, now);
    policy({ userId, unit: "model_calls", hardLimit: 1, period: "daily" });
    policy({ userId, unit: "output_tokens", hardLimit: 1, period: "monthly" });
    reserve({ userId, runId, taskId: taskA, resources: { model_calls: 1, output_tokens: 1 }, now: new Date(now) });
    expect(() => reserve({ userId, runId, taskId: taskB, resources: { model_calls: 1, output_tokens: 1 }, now: new Date("2026-02-01T00:00:00.000Z") })).not.toThrow();
    policy({ userId, unit: "task_starts", hardLimit: 1, period: "task" });
    reserve({ userId, runId, taskId: taskA, resources: { task_starts: 1 } });
    expect(() => reserve({ userId, runId, taskId: taskA, resources: { task_starts: 1 } })).toThrow(/task_starts/);
    expect(() => reserve({ userId, runId, taskId: taskB, resources: { task_starts: 1 } })).not.toThrow();
  });

  it("settles actual tokens and retains conservative estimates when provider usage is unavailable", () => {
    const userId = getTestUser();
    const estimated = reserveUsage({ userId, provider: "openai", modelId: "unknown-usage", estimatedInputTokens: 120, maxOutputTokens: 300 });
    settleUsage(estimated, {});
    const conservative = getDb().prepare("SELECT unit,consumed_units AS consumed FROM resource_usage_records WHERE usage_record_id=? ORDER BY unit").all(estimated) as Array<{ unit: string; consumed: number }>;
    expect(Object.fromEntries(conservative.map((row) => [row.unit, row.consumed]))).toMatchObject({ model_calls: 1, input_tokens: 120, output_tokens: 300 });
    const actual = reserveUsage({ userId, provider: "openai", modelId: "actual-usage", estimatedInputTokens: 120, maxOutputTokens: 300 });
    settleUsage(actual, { inputTokens: 40, outputTokens: 20 });
    const settled = getDb().prepare("SELECT unit,consumed_units AS consumed FROM resource_usage_records WHERE usage_record_id=? ORDER BY unit").all(actual) as Array<{ unit: string; consumed: number }>;
    expect(Object.fromEntries(settled.map((row) => [row.unit, row.consumed]))).toMatchObject({ model_calls: 1, input_tokens: 40, output_tokens: 20 });
  });

  it("releases provider reservations on failure and expiry recovery", () => {
    const userId = getTestUser(); policy({ userId, unit: "model_calls", hardLimit: 1 });
    const failed = reserveUsage({ userId, provider: "openai", modelId: "failed", estimatedInputTokens: 1, maxOutputTokens: 1 });
    releaseUsage(failed);
    const afterFailure = reserveUsage({ userId, provider: "openai", modelId: "after-failure", estimatedInputTokens: 1, maxOutputTokens: 1 });
    releaseUsage(afterFailure);
    const expired = reserve({ userId, resources: { model_calls: 1 }, reservationExpiresAt: "2020-01-01T00:00:00.000Z" });
    expect(recoverExpiredBudgetReservations(new Date("2020-01-02T00:00:00.000Z"))).toBeGreaterThan(0);
    expect(getDb().prepare("SELECT status FROM resource_usage_records WHERE id=?").get(expired[0])).toEqual({ status: "released" });
  });

  it("shares run quota across parent and delegated-agent identities", () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Delegation ${randomUUID()}`); const run = runContext(userId, projectId); const childAgent = createAgent(userId, { name: `Child ${randomUUID()}`, role: "child", instructions: "child" });
    policy({ userId, unit: "model_calls", scope: "run", runId: run.runId, hardLimit: 1, period: "run" });
    reserve({ userId, projectId, runId: run.runId, agentId: run.agentId, resources: { model_calls: 1 } });
    expect(() => reserve({ userId, projectId, runId: run.runId, agentId: childAgent, resources: { model_calls: 1 } })).toThrowError(expect.objectContaining<Partial<GatewayError>>({ code: "budget_exceeded" }));
  });

  it("enforces snapshotted agent per-run model, output-token, and tool caps", () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Agent caps ${randomUUID()}`); const { runId, agentId } = runContext(userId, projectId);
    const budget = { perRun: { modelCalls: 1, outputTokens: 20, toolCalls: 1 } };
    reserve({ userId, projectId, runId, agentId, resources: { model_calls: 1, output_tokens: 20, tool_calls: 1 }, agentBudget: budget });
    for (const resources of [{ model_calls: 1 }, { output_tokens: 1 }, { tool_calls: 1 }]) {
      expect(() => reserve({ userId, projectId, runId, agentId, resources, agentBudget: budget })).toThrow(/agent per-run/);
    }
  });

  it("excludes released reservations from the dashboard settled-cost total", () => {
    const db = getDb(); const userId = getTestUser(); const before = dashboard(userId).monthCostMicros; const now = new Date().toISOString();
    const settledId = randomUUID(); const releasedId = randomUUID();
    db.prepare(`INSERT INTO usage_records (id,user_id,provider,model_id,estimated_cost_micros,billed_cost_micros,currency,status,created_at,settled_at)
      VALUES (?,?, 'openai','dashboard',100,100,'USD','settled',?,?)`).run(settledId, userId, now, now);
    db.prepare(`INSERT INTO usage_records (id,user_id,provider,model_id,estimated_cost_micros,currency,status,created_at,settled_at)
      VALUES (?,?, 'openai','dashboard',999,'USD','released',?,?)`).run(releasedId, userId, now, now);
    expect(dashboard(userId).monthCostMicros).toBe(before + 100);
    db.prepare("DELETE FROM usage_records WHERE id IN (?,?)").run(settledId, releasedId);
  });

  it("consumes task/tool events without leaving reservations", () => {
    const userId = getTestUser(); policy({ userId, unit: "tool_calls", hardLimit: 1 }); policy({ userId, unit: "task_starts", hardLimit: 1 });
    const ids = reserve({ userId, resources: { tool_calls: 1, task_starts: 1 } });
    consumeResourceReservations(ids, { tool_calls: 1, task_starts: 1 });
    expect(getDb().prepare("SELECT count(*) AS count FROM resource_usage_records WHERE id IN (?,?) AND status='consumed'").get(...ids)).toEqual({ count: 2 });
    expect(() => reserve({ userId, resources: { tool_calls: 1 } })).toThrow(/tool_calls/);
    expect(() => reserve({ userId, resources: { task_starts: 1 } })).toThrow(/task_starts/);
  });
});


describe("provider dispatch accounting boundary", () => {
  it("consumes model calls at dispatch and conservatively retains post-dispatch failure and expiry", () => {
    const userId = getTestUser();
    const failed = reserveUsage({ userId, provider: "openai", modelId: "possibly-billed", estimatedCostMicros: 250, currency: "USD", estimatedInputTokens: 40, maxOutputTokens: 80 });
    dispatchUsage(failed);
    expect(getDb().prepare("SELECT status FROM resource_usage_records WHERE usage_record_id=? AND unit='model_calls'").get(failed)).toEqual({ status: "consumed" });
    releaseUsage(failed);
    expect(getDb().prepare("SELECT status,accounting_outcome AS outcome,billed_cost_micros AS cost FROM usage_records WHERE id=?").get(failed)).toEqual({ status: "settled", outcome: "unknown", cost: 250 });
    expect(getDb().prepare("SELECT count(*) AS count FROM resource_usage_records WHERE usage_record_id=? AND status='consumed'").get(failed)).toEqual({ count: 3 });

    const expired = reserveUsage({ userId, provider: "openai", modelId: "expired-dispatch", estimatedInputTokens: 5, maxOutputTokens: 7, reservationExpiresAt: "2020-01-01T00:00:00.000Z" });
    dispatchUsage(expired, new Date("2019-12-31T23:59:59.000Z"));
    recoverExpiredBudgetReservations(new Date("2020-01-02T00:00:00.000Z"));
    expect(getDb().prepare("SELECT status,accounting_outcome AS outcome FROM usage_records WHERE id=?").get(expired)).toEqual({ status: "settled", outcome: "unknown" });
  });
});
