import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestUser } from "@/tests/helpers";
import { getDb } from "@/src/core/database";
import { createConnection } from "@/src/modules/gateway/connections";
import { cancelRun, createAgent, createAgentRun, getRun, listAgents } from "@/src/modules/agents/service";
import { createProject } from "@/src/modules/workspace/service";
import { workerTick } from "@/src/modules/agents/runtime";

let userId: string;
let projectId: string;
let connectionId: string;
let modelId: string;

beforeAll(() => {
  const db = getDb(); userId = getTestUser(); const now = new Date().toISOString();
  projectId = createProject(userId, "Test project"); connectionId = createConnection(userId, { provider: "openai", label: "Mock provider", apiKey: "sk-test" }); modelId = "mock-model";
  db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?)`).run(randomUUID(), connectionId, modelId, "Mock Model", '{"text":"supported","streaming":"supported"}', now, now);
  db.prepare("UPDATE provider_connections SET status='connected' WHERE id=?").run(connectionId);
});

describe("durable multi-agent orchestration", () => {
  it("runs independent tasks, persists outputs, then synthesizes", async () => {
    const active = { count: 0, max: 0 };
    vi.stubGlobal("fetch", vi.fn(async () => {
      active.count += 1; active.max = Math.max(active.max, active.count);
      await new Promise((resolve) => setTimeout(resolve, 10)); active.count -= 1;
      return new Response('data: {"choices":[{"delta":{"content":"verified output"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { status: 200 });
    }));
    const agents = listAgents(userId).filter((agent) => String(agent.slug) === "general-assistant" || String(agent.slug) === "product-strategist").slice(0, 2).map((agent) => String(agent.id));
    const runId = createAgentRun({ userId, projectId, goal: "Produce and verify a concise result", mode: "team", agentIds: agents, targets: [{ connectionId, modelId }], maxParallelism: 2 });
    await workerTick();
    let run = getRun(userId, runId)!;
    expect(run.tasks.filter((task) => task.depth === 0).every((task) => task.status === "succeeded")).toBe(true);
    expect(run.tasks.find((task) => task.depth === 1)?.status).toBe("ready");
    await workerTick();
    run = getRun(userId, runId)!;
    expect(run.status).toBe("succeeded");
    expect(run.tasks).toHaveLength(3);
    expect(run.tasks.every((task) => task.output?.content === "verified output")).toBe(true);
    expect(active.max).toBeGreaterThanOrEqual(2);
    const events = getDb().prepare("SELECT event_type AS type FROM task_events WHERE run_id=?").all(runId) as Array<{ type: string }>;
    expect(events.some((event) => event.type === "AgentStarted")).toBe(true);
    expect(events.some((event) => event.type === "ArtifactProduced")).toBe(true);
    const usage = getDb().prepare("SELECT status FROM usage_records WHERE run_id=?").all(runId) as Array<{ status: string }>;
    expect(usage).toHaveLength(3);
    expect(usage.every((item) => item.status === "settled")).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("task-start resource-budget enforcement", () => {
  it("fails a task with typed budget_exceeded before creating an attempt or provider call", async () => {
    const db = getDb(); const policyId = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO resource_budget_policies (id,user_id,unit,scope_type,project_id,period,hard_limit,created_at,updated_at)
      VALUES (?,?,'task_starts','project',?,'run',0,?,?)`).run(policyId, userId, projectId, now, now);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    try {
      const agentId = String(listAgents(userId).find((agent) => String(agent.slug) === "general-assistant")!.id);
      const runId = createAgentRun({ userId, projectId, goal: "Do not start over budget", mode: "team", agentIds: [agentId], targets: [{ connectionId, modelId }] });
      await workerTick();
      const run = getRun(userId, runId)!;
      expect(run.status).toBe("failed");
      expect(run.tasks.every((task) => task.status === "failed" && task.errorCode === "budget_exceeded")).toBe(true);
      expect(db.prepare("SELECT count(*) AS count FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE run_id=?)").get(runId)).toEqual({ count: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      db.prepare("DELETE FROM resource_budget_policies WHERE id=?").run(policyId);
      vi.unstubAllGlobals();
    }
  });
});

describe("stored agent resource-budget snapshots", () => {
  it("enforces a per-run model-call cap before provider dispatch", async () => {
    const agentId = createAgent(userId, { name: `Zero-call ${randomUUID()}`, role: "budget", instructions: "budget", budget: { perRun: { modelCalls: 0 } } });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const runId = createAgentRun({ userId, projectId, goal: "Agent snapshot budget", mode: "team", agentIds: [agentId], targets: [{ connectionId, modelId }] });
    try {
      await workerTick();
      const root = getRun(userId, runId)!.tasks.find((task) => task.assignedAgentId === agentId)!;
      expect(root.status).toBe("failed");
      expect(root.errorCode).toBe("budget_exceeded");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      cancelRun(userId, runId);
      vi.unstubAllGlobals();
    }
  });
});