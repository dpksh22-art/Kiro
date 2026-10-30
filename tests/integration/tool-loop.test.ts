import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/src/core/database";
import { getTestUser } from "@/tests/helpers";
import { createProject } from "@/src/modules/workspace/service";
import { createMemory } from "@/src/modules/workspace/memory";
import { uploadArtifact } from "@/src/modules/artifacts/service";
import { executeBrokerTool } from "@/src/modules/agents/tool-broker";
import { createAgent, createAgentRun, getRun } from "@/src/modules/agents/service";
import { createConnection } from "@/src/modules/gateway/connections";
import { workerTick } from "@/src/modules/agents/runtime";

function bytes(text: string) { return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }); }
function authority(userId: string, projectId: string) {
  const db = getDb(); const now = new Date().toISOString(); const runId = randomUUID(); const taskId = randomUUID(); const attemptId = randomUUID(); const lease = randomUUID();
  const agentId = createAgent(userId, { name: `Broker ${randomUUID()}`, role: "broker test", instructions: "test", allowedTools: ["artifact_text_read"], permissionPolicy: { mode: "read_only", maxToolCalls: 4 } });
  db.prepare(`INSERT INTO task_runs (id,user_id,project_id,title,goal,mode,status,max_parallelism,max_tasks,max_depth,deadline_at,created_at,updated_at)
    VALUES (?,?,?,'broker','broker','team','running',1,1,0,?,?,?)`).run(runId, userId, projectId, new Date(Date.now() + 60_000).toISOString(), now, now);
  db.prepare(`INSERT INTO tasks (id,run_id,assigned_agent_id,task_key,title,description,task_type,status,lease_token,lease_expires_at,input_json,created_at,updated_at)
    VALUES (?,?,?,'broker','broker','broker','model_agent','running',?,?, '{}',?,?)`).run(taskId, runId, agentId, lease, new Date(Date.now() + 60_000).toISOString(), now, now);
  db.prepare(`INSERT INTO task_attempts (id,task_id,attempt_number,status,lease_token,started_at,heartbeat_at) VALUES (?,?,1,'running',?,?,?)`).run(attemptId, taskId, lease, now, now);
  return { userId, projectId, runId, taskId, attemptId, allowedTools: ["artifact_text_read"], permissionPolicy: { mode: "read_only", maxToolCalls: 4 }, signal: new AbortController().signal, deadlineMs: Date.now() + 60_000 };
}

describe("read-only broker and bounded tool loop", () => {
  it("allows clean owner text and audits validation/deny/quarantine failures", async () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Broker ${randomUUID()}`); const context = authority(userId, projectId);
    const clean = await uploadArtifact({ userId, projectId, filename: "notes.txt", declaredMediaType: "text/plain", stream: bytes("trusted bytes, untrusted content") });
    const result = await executeBrokerTool(context, { id: "clean-call", name: "artifact_text_read", arguments: { artifactId: clean.id } });
    expect(JSON.parse(result)).toMatchObject({ artifactId: clean.id, trust: "untrusted_artifact", content: "trusted bytes, untrusted content" });
    await expect(executeBrokerTool(context, { id: "denied-call", name: "web_fetch", arguments: { url: "https://example.com" } })).rejects.toThrow(/not allowed/i);
    await expect(executeBrokerTool(context, { id: "invalid-call", name: "artifact_text_read", arguments: { artifactId: "not-a-uuid" } })).rejects.toThrow(/invalid arguments/i);
    const quarantined = await uploadArtifact({ userId, projectId, filename: "pending.txt", declaredMediaType: "text/plain", stream: bytes("pending"), scanner: { name: "pending-test", async scan() { return { status: "quarantined", mediaType: "text/plain" }; } } });
    await expect(executeBrokerTool(context, { id: "quarantine-call", name: "artifact_text_read", arguments: { artifactId: quarantined.id } })).rejects.toThrow(/quarantined/i);
    await expect(executeBrokerTool(context, { id: "over-limit", name: "artifact_text_read", arguments: { artifactId: clean.id } })).rejects.toThrow(/maximum tool calls/i);
    await expect(executeBrokerTool({ ...context, userId: randomUUID() }, { id: "cross-owner", name: "artifact_text_read", arguments: { artifactId: clean.id } })).rejects.toThrow(/authority|quiescing/i);
    const cancelledContext = authority(userId, projectId); const cancelled = new AbortController(); cancelled.abort();
    await expect(executeBrokerTool({ ...cancelledContext, signal: cancelled.signal }, { id: "cancelled", name: "artifact_text_read", arguments: { artifactId: clean.id } })).rejects.toThrow(/cancelled/i);
    const expiredContext = authority(userId, projectId);
    await expect(executeBrokerTool({ ...expiredContext, deadlineMs: Date.now() - 1 }, { id: "expired", name: "artifact_text_read", arguments: { artifactId: clean.id } })).rejects.toThrow(/deadline/i);
    const rows = getDb().prepare("SELECT status FROM tool_invocations WHERE attempt_id=? ORDER BY started_at,id").all(context.attemptId) as Array<{ status: string }>;
    expect(rows.map((row) => row.status).sort()).toEqual(["completed", "failed", "failed", "failed"]);
    const resources = getDb().prepare("SELECT status FROM resource_usage_records WHERE attempt_id=? AND unit='tool_calls' ORDER BY created_at,id").all(context.attemptId) as Array<{ status: string }>;
    expect(resources.map((row) => row.status).sort()).toEqual(["consumed", "consumed", "released", "released"]);
    const events = getDb().prepare("SELECT event_type AS type FROM task_events WHERE task_id=?").all(context.taskId) as Array<{ type: string }>;
    expect(events.filter((event) => event.type === "ToolRequested")).toHaveLength(4);
    expect(events.filter((event) => event.type === "ToolCompleted")).toHaveLength(4);
  });

  it("executes a successful two-turn artifact tool loop and persists trace", async () => {
    const db = getDb(); const userId = getTestUser(); const projectId = createProject(userId, `Loop ${randomUUID()}`);
    const artifact = await uploadArtifact({ userId, projectId, filename: "input.json", declaredMediaType: "application/json", stream: bytes('{"fact":"verified"}') });
    createMemory(userId, { projectId, kind: "instruction", content: "AGENT_TRUSTED_MEMORY", retentionPolicy: "permanent" });
    const connectionId = createConnection(userId, { provider: "openai", label: `Loop ${randomUUID()}`, apiKey: "sk-test" });
    const modelId = `loop-${randomUUID()}`; const now = new Date().toISOString();
    db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?)`).run(randomUUID(), connectionId, modelId, "Loop Model", '{"text":"supported","streaming":"supported","tools":"supported"}', now, now);
    db.prepare("UPDATE provider_connections SET status='connected' WHERE id=?").run(connectionId);
    const agentId = createAgent(userId, { name: `Reader ${randomUUID()}`, role: "reader", instructions: "Read the artifact, then answer.", allowedTools: ["artifact_text_read"], permissionPolicy: { mode: "read_only", maxToolCalls: 2 }, maxTurns: 3 });
    const requestBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requestBodies.push(String(init.body));
      const body = JSON.parse(String(init.body)) as { messages?: Array<{ role?: string }>; tools?: unknown };
      if (body.tools && !body.messages?.some((message) => message.role === "tool")) return new Response([
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"read-1","function":{"name":"artifact_text_read","arguments":"{\\"artifactId\\":\\"${artifact.id}\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n', 'data: [DONE]\n\n',
      ].join(""), { status: 200 });
      return new Response('data: {"choices":[{"delta":{"content":"Final verified answer"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n', { status: 200 });
    }));
    const runId = createAgentRun({ userId, projectId, goal: "Use the supplied artifact", mode: "team", agentIds: [agentId], targets: [{ connectionId, modelId }] });
    await workerTick();
    let run = getRun(userId, runId)!;
    const root = run.tasks.find((task) => task.depth === 0)!;
    expect(root.status).toBe("succeeded");
    expect(root.output?.content).toBe("Final verified answer");
    expect(requestBodies[0]).toContain("AGENT_TRUSTED_MEMORY");
    expect(requestBodies[0]).toContain("provenance: explicit_user");
    expect(root.output?.trace).toEqual(expect.arrayContaining([expect.stringMatching(/^Turn 1:/), expect.stringMatching(/^Tool artifact_text_read/), expect.stringMatching(/^Turn 2:/)]));
    expect(db.prepare("SELECT status FROM tool_invocations WHERE task_id=?").get(root.id)).toMatchObject({ status: "completed" });
    await workerTick();
    run = getRun(userId, runId)!;
    expect(run.status).toBe("succeeded");
    const usage = db.prepare("SELECT status FROM usage_records WHERE run_id=?").all(runId) as Array<{ status: string }>;
    expect(usage).toHaveLength(3);
    expect(usage.every((row) => row.status === "settled")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("stops repeated calls and calls that exhaust the turn bound", async () => {
    const db = getDb(); const userId = getTestUser(); const projectId = createProject(userId, `Bounds ${randomUUID()}`);
    const artifact = await uploadArtifact({ userId, projectId, filename: "bounded.txt", declaredMediaType: "text/plain", stream: bytes("bounded") });
    const connectionId = createConnection(userId, { provider: "openai", label: `Bounds ${randomUUID()}`, apiKey: "key" }); const modelId = `bounds-${randomUUID()}`; const now = new Date().toISOString();
    db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?)`).run(randomUUID(), connectionId, modelId, "Bounds Model", '{"text":"supported","tools":"supported"}', now, now);
    db.prepare("UPDATE provider_connections SET status='connected' WHERE id=?").run(connectionId);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"same-call","function":{"name":"artifact_text_read","arguments":"{\\"artifactId\\":\\"${artifact.id}\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`, { status: 200 })));
    const repeatingAgent = createAgent(userId, { name: `Repeater ${randomUUID()}`, role: "reader", instructions: "read", allowedTools: ["artifact_text_read"], permissionPolicy: { mode: "read_only", maxToolCalls: 3 }, maxTurns: 3 });
    const repeatedRun = createAgentRun({ userId, projectId, goal: "repeat", mode: "team", agentIds: [repeatingAgent], targets: [{ connectionId, modelId }] });
    await workerTick();
    const repeatedRoot = getRun(userId, repeatedRun)!.tasks.find((task) => task.depth === 0)!;
    expect(repeatedRoot.status).toBe("retry_wait");
    expect(repeatedRoot.errorMessage).toMatch(/repeating the same tool call/i);
    expect(db.prepare("SELECT count(*) AS count FROM tool_invocations WHERE task_id=?").get(repeatedRoot.id)).toEqual({ count: 1 });
    expect((db.prepare("SELECT count(*) AS count FROM usage_records WHERE task_id=? AND status='settled'").get(repeatedRoot.id) as { count: number }).count).toBeGreaterThanOrEqual(2);
    const oneTurnAgent = createAgent(userId, { name: `One turn ${randomUUID()}`, role: "reader", instructions: "read", allowedTools: ["artifact_text_read"], permissionPolicy: { mode: "read_only", maxToolCalls: 1 }, maxTurns: 1 });
    const oneTurnRun = createAgentRun({ userId, projectId, goal: "one turn", mode: "team", agentIds: [oneTurnAgent], targets: [{ connectionId, modelId }] });
    await workerTick();
    const oneTurnRoot = getRun(userId, oneTurnRun)!.tasks.find((task) => task.depth === 0)!;
    expect(oneTurnRoot.status).toBe("retry_wait");
    expect(oneTurnRoot.errorMessage).toMatch(/maximum agent turns/i);
    expect(db.prepare("SELECT count(*) AS count FROM tool_invocations WHERE task_id=?").get(oneTurnRoot.id)).toEqual({ count: 0 });
    const unknownModelId = `unknown-${randomUUID()}`;
    db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?)`).run(randomUUID(), connectionId, unknownModelId, "Unknown Tool Model", '{"text":"supported","tools":"unknown"}', now, now);
    const unknownRun = createAgentRun({ userId, projectId, goal: "reject unknown", mode: "team", agentIds: [repeatingAgent], targets: [{ connectionId, modelId: unknownModelId }] });
    await workerTick();
    const unknownRoot = getRun(userId, unknownRun)!.tasks.find((task) => task.depth === 0)!;
    expect(unknownRoot.errorMessage).toMatch(/unknown tools capability/i);
    vi.unstubAllGlobals();
  });
});

describe("tool resource-budget enforcement", () => {
  it("rejects a broker invocation before execution when project tool quota is exhausted", async () => {
    const db = getDb(); const userId = getTestUser(); const projectId = createProject(userId, `Tool budget ${randomUUID()}`); const context = authority(userId, projectId);
    const artifact = await uploadArtifact({ userId, projectId, filename: "budget.txt", declaredMediaType: "text/plain", stream: bytes("budgeted") });
    const policyId = randomUUID(); const now = new Date().toISOString();
    db.prepare(`INSERT INTO resource_budget_policies (id,user_id,unit,scope_type,project_id,period,hard_limit,created_at,updated_at)
      VALUES (?,?,'tool_calls','project',?,'daily',0,?,?)`).run(policyId, userId, projectId, now, now);
    try {
      await expect(executeBrokerTool(context, { id: "budget-denied", name: "artifact_text_read", arguments: { artifactId: artifact.id } })).rejects.toMatchObject({ code: "budget_exceeded" });
      expect(db.prepare("SELECT count(*) AS count FROM tool_invocations WHERE attempt_id=?").get(context.attemptId)).toEqual({ count: 0 });
      expect(db.prepare("SELECT count(*) AS count FROM resource_usage_records WHERE attempt_id=?").get(context.attemptId)).toEqual({ count: 0 });
    } finally {
      db.prepare("DELETE FROM resource_budget_policies WHERE id=?").run(policyId);
    }
  });
});