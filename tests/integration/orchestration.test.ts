import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestUser } from "@/tests/helpers";
import { getDb } from "@/src/core/database";
import { createConnection } from "@/src/modules/gateway/connections";
import { createAgentRun, getRun, listAgents } from "@/src/modules/agents/service";
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
    const agents = listAgents(userId).slice(0, 2).map((agent) => String(agent.id));
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
