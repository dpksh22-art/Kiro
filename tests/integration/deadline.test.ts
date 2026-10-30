import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestUser } from "@/tests/helpers";
import { getDb } from "@/src/core/database";
import { createProject } from "@/src/modules/workspace/service";
import { createConnection } from "@/src/modules/gateway/connections";
import { createAgentRun, getRun, listAgents } from "@/src/modules/agents/service";
import { workerTick } from "@/src/modules/agents/runtime";

describe("run deadline enforcement", () => {
  it("aborts an active provider request at the earlier run deadline", async () => {
    const db = getDb(); const userId = getTestUser(); const now = new Date().toISOString();
    const projectId = createProject(userId, `Deadline ${randomUUID()}`);
    const connectionId = createConnection(userId, { provider: "openai", label: `Deadline ${randomUUID()}`, apiKey: "sk-test" });
    const modelId = `deadline-${randomUUID()}`;
    db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?)`).run(randomUUID(), connectionId, modelId, "Deadline Model", '{"text":"supported"}', now, now);
    db.prepare("UPDATE provider_connections SET status='connected' WHERE id=?").run(connectionId);
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const agentId = String(listAgents(userId).find((agent) => String(agent.slug) === "general-assistant")!.id);
    const runId = createAgentRun({ userId, projectId, goal: "Respect the run deadline", mode: "team", agentIds: [agentId], targets: [{ connectionId, modelId }], deadlineSeconds: 0.05 });
    await workerTick();
    await workerTick();
    const run = getRun(userId, runId)!;
    expect(run.status).toBe("failed");
    expect(run.tasks.some((task) => task.errorCode === "deadline_exceeded")).toBe(true);
    const attempts = db.prepare(`SELECT status,error_code AS errorCode FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE run_id=?)`).all(runId) as Array<{ status: string; errorCode: string }>;
    expect(attempts.every((attempt) => attempt.status === "failed" && attempt.errorCode === "deadline_exceeded")).toBe(true);
    expect(db.prepare("SELECT count(*) AS count FROM resource_usage_records WHERE run_id=? AND status='reserved'").get(runId)).toEqual({ count: 0 });
    expect((db.prepare("SELECT count(*) AS count FROM usage_records WHERE run_id=? AND accounting_outcome='unknown'").get(runId) as { count: number }).count).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});
