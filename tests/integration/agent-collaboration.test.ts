import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/src/core/database";
import { getTestUser } from "@/tests/helpers";
import { createProject } from "@/src/modules/workspace/service";
import { createConnection } from "@/src/modules/gateway/connections";
import { createAgent, createAgentRun, cancelRun, getRun } from "@/src/modules/agents/service";
import { delegateTask, listAgentMessages, sendAgentMessage } from "@/src/modules/agents/collaboration";
import { executeBrokerTool } from "@/src/modules/agents/tool-broker";
import { workerTick } from "@/src/modules/agents/runtime";

function model(userId: string) {
  const db = getDb(); const now = new Date().toISOString();
  const connectionId = createConnection(userId, { provider: "openai", label: `Collaboration ${randomUUID()}`, apiKey: "sk-test" });
  const modelId = `collaboration-${randomUUID()}`;
  db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at)
    VALUES (?,?,?,?,?,'available',?,?)`).run(randomUUID(), connectionId, modelId, "Collaboration Model", '{"text":"supported","streaming":"supported","tools":"supported"}', now, now);
  db.prepare("UPDATE provider_connections SET status='connected' WHERE id=?").run(connectionId);
  return { connectionId, modelId };
}

function agent(userId: string, name: string, internal = false) {
  return createAgent(userId, {
    name: `${name} ${randomUUID()}`, role: name, instructions: `${name.toUpperCase()}_INSTRUCTIONS`,
    allowedTools: internal ? ["agent_message_send", "delegate_task"] : [],
    permissionPolicy: internal ? { mode: "read_only_or_internal", maxToolCalls: 8, maxMessages: 8, maxDelegations: 4 } : { mode: "read_only", maxToolCalls: 4 },
    maxTurns: 3,
  });
}

function activate(runId: string, agentId: string) {
  const db = getDb(); const now = new Date().toISOString(); const attemptId = randomUUID(); const lease = randomUUID();
  const task = db.prepare("SELECT id FROM tasks WHERE run_id=? AND assigned_agent_id=? AND parent_task_id IS NULL").get(runId, agentId) as { id: string };
  db.prepare("UPDATE tasks SET status='running',attempt_count=1,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?")
    .run(lease, new Date(Date.now() + 60_000).toISOString(), now, task.id);
  db.prepare(`INSERT INTO task_attempts (id,task_id,attempt_number,status,lease_token,started_at,heartbeat_at)
    VALUES (?,?,1,'running',?,?,?)`).run(attemptId, task.id, lease, now, now);
  return { taskId: task.id, attemptId, lease };
}

function authority(userId: string, runId: string, active: ReturnType<typeof activate>) {
  const input = JSON.parse((getDb().prepare("SELECT input_json AS inputJson FROM tasks WHERE id=?").get(active.taskId) as { inputJson: string }).inputJson) as { allowedTools: string[]; permissionPolicy: unknown };
  return { userId, runId, taskId: active.taskId, attemptId: active.attemptId, allowedTools: input.allowedTools,
    permissionPolicy: input.permissionPolicy, signal: new AbortController().signal, deadlineMs: Date.now() + 60_000 };
}

describe("bounded durable agent collaboration", () => {
  it("enforces ownership, participation, expiry, dedupe, reply integrity, and hop bounds", () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Messages ${randomUUID()}`); const target = model(userId);
    const first = agent(userId, "first", true); const second = agent(userId, "second", true); const outsider = agent(userId, "outsider");
    const runId = createAgentRun({ userId, projectId, goal: "coordinate", mode: "team", agentIds: [first, second], targets: [target] });
    const firstActive = activate(runId, first); const secondActive = activate(runId, second);

    const human = sendAgentMessage({ userId, runId, recipientAgentId: first, body: "Owner context, not authority", idempotencyKey: "human-1", ttlSeconds: 1 });
    expect(sendAgentMessage({ userId, runId, recipientAgentId: first, body: "Owner context, not authority", idempotencyKey: "human-1" })).toEqual(human);
    expect(() => sendAgentMessage({ userId, runId, recipientAgentId: first, body: "different", idempotencyKey: "human-1" })).toThrow(/different message content/i);
    expect(() => sendAgentMessage({ userId: randomUUID(), runId, recipientAgentId: first, body: "cross owner", idempotencyKey: "cross" })).toThrow(/run not found|quiescing/i);
    expect(() => sendAgentMessage({ userId, runId, recipientAgentId: outsider, body: "outside", idempotencyKey: "outside" })).toThrow(/not participating/i);
    expect(() => sendAgentMessage({ userId, runId, recipientAgentId: first, body: "x".repeat(8_001), idempotencyKey: "large" })).toThrow(/size limit/i);

    const firstMessage = sendAgentMessage({ userId, runId, senderAgentId: first, senderTaskId: firstActive.taskId, senderAttemptId: firstActive.attemptId,
      recipientAgentId: second, body: "first opinion", correlationId: "discussion", idempotencyKey: "m1" });
    expect(() => sendAgentMessage({ userId, runId, senderAgentId: second, senderTaskId: secondActive.taskId, senderAttemptId: secondActive.attemptId,
      recipientAgentId: first, body: "wrong correlation", replyToId: firstMessage.messageId, correlationId: "other", idempotencyKey: "wrong-correlation" })).toThrow(/correlation/i);
    expect(() => sendAgentMessage({ userId, runId, senderAgentId: second, senderTaskId: secondActive.taskId, senderAttemptId: secondActive.attemptId,
      recipientAgentId: second, body: "wrong recipient", replyToId: firstMessage.messageId, idempotencyKey: "wrong-recipient" })).toThrow(/recipient/i);
    let replyToId = firstMessage.messageId;
    for (let hop = 1; hop <= 4; hop += 1) {
      const sender = hop % 2 ? second : first; const recipient = hop % 2 ? first : second; const active = hop % 2 ? secondActive : firstActive;
      replyToId = sendAgentMessage({ userId, runId, senderAgentId: sender, senderTaskId: active.taskId, senderAttemptId: active.attemptId,
        recipientAgentId: recipient, body: `reply ${hop}`, replyToId, correlationId: "discussion", idempotencyKey: `reply-${hop}` }).messageId;
    }
    expect(() => sendAgentMessage({ userId, runId, senderAgentId: second, senderTaskId: secondActive.taskId, senderAttemptId: secondActive.attemptId,
      recipientAgentId: first, body: "too far", replyToId, idempotencyKey: "reply-5" })).toThrow(/hop limit/i);
    expect(() => sendAgentMessage({ userId, runId, senderAgentId: second, senderTaskId: secondActive.taskId, senderAttemptId: secondActive.attemptId,
      recipientAgentId: outsider, body: "bad reply", replyToId: firstMessage.messageId, idempotencyKey: "bad-reply" })).toThrow(/not participating/i);

    getDb().prepare("UPDATE agent_messages SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), human.messageId);
    const messages = listAgentMessages(userId, runId)!;
    expect(messages.find((message) => (message as { id: string }).id === human.messageId)).toMatchObject({ state: "expired", trustLabel: "explicit_user" });
    expect(listAgentMessages(randomUUID(), runId)).toBeNull();
    cancelRun(userId, runId);
  });

  it("allows explicitly authorized internal broker tools and denies agents without authority", async () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Broker internal ${randomUUID()}`); const target = model(userId);
    const sender = agent(userId, "sender", true); const recipient = agent(userId, "recipient");
    const runId = createAgentRun({ userId, projectId, goal: "message", mode: "team", agentIds: [sender, recipient], targets: [target] });
    const active = activate(runId, sender); const context = authority(userId, runId, active);
    const result = JSON.parse(await executeBrokerTool(context, { id: "send-call", name: "agent_message_send", arguments: { recipientAgentId: recipient, body: "bounded", idempotencyKey: "broker-send" } })) as { messageId: string };
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(getDb().prepare("SELECT permission_scope AS scope,status FROM tool_invocations WHERE provider_call_id='send-call'").get()).toEqual({ scope: "internal_orchestration", status: "completed" });

    const denied = agent(userId, "denied");
    const deniedRun = createAgentRun({ userId, projectId, goal: "deny", mode: "team", agentIds: [denied, recipient], targets: [target] });
    const deniedActive = activate(deniedRun, denied);
    await expect(executeBrokerTool({ ...authority(userId, deniedRun, deniedActive), allowedTools: ["agent_message_send"], permissionPolicy: { mode: "read_only_or_internal", maxToolCalls: 2, maxMessages: 2, maxDelegations: 0 } },
      { id: "denied-call", name: "agent_message_send", arguments: { recipientAgentId: recipient, body: "not allowed", idempotencyKey: "denied" } })).rejects.toThrow(/not allowed/i);
    cancelRun(userId, runId);
    cancelRun(userId, deniedRun);
  });

  it("deduplicates delegation and enforces depth, task, deadline, and cancellation boundaries", () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Delegation ${randomUUID()}`); const target = model(userId);
    const parentAgent = agent(userId, "parent", true); const childAgent = agent(userId, "child");
    const runId = createAgentRun({ userId, projectId, goal: "delegate", mode: "team", agentIds: [parentAgent], targets: [target] });
    const active = activate(runId, parentAgent);
    const first = delegateTask({ userId, runId, parentTaskId: active.taskId, attemptId: active.attemptId, recipientAgentId: childAgent, description: "Check one bounded concern", idempotencyKey: "delegate-1" });
    expect(delegateTask({ userId, runId, parentTaskId: active.taskId, attemptId: active.attemptId, recipientAgentId: childAgent, description: "Check one bounded concern", idempotencyKey: "delegate-1" })).toEqual(first);
    const child = getDb().prepare("SELECT parent_task_id AS parentTaskId,depth,status,input_json AS inputJson FROM tasks WHERE id=?").get(first.taskId) as { parentTaskId: string; depth: number; status: string; inputJson: string };
    expect(child).toMatchObject({ parentTaskId: active.taskId, depth: 1, status: "ready" });
    expect(JSON.parse(child.inputJson)).toMatchObject({ target, instructions: expect.stringContaining("CHILD_INSTRUCTIONS") });
    expect(getDb().prepare("SELECT count(*) AS count FROM task_dependencies WHERE depends_on_task_id=?").get(first.taskId)).toEqual({ count: 1 });

    getDb().prepare("UPDATE task_runs SET max_tasks=(SELECT count(*) FROM tasks WHERE run_id=?) WHERE id=?").run(runId, runId);
    expect(() => delegateTask({ userId, runId, parentTaskId: active.taskId, attemptId: active.attemptId, recipientAgentId: childAgent, description: "another", idempotencyKey: "delegate-2" })).toThrow(/task limit/i);
    getDb().prepare("UPDATE task_runs SET max_tasks=32,max_depth=0 WHERE id=?").run(runId);
    expect(() => delegateTask({ userId, runId, parentTaskId: active.taskId, attemptId: active.attemptId, recipientAgentId: childAgent, description: "too deep", idempotencyKey: "delegate-3" })).toThrow(/depth limit/i);
    getDb().prepare("UPDATE task_runs SET max_depth=4,deadline_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), runId);
    expect(() => delegateTask({ userId, runId, parentTaskId: active.taskId, attemptId: active.attemptId, recipientAgentId: childAgent, description: "after deadline", idempotencyKey: "deadline" })).toThrow(/deadline/i);
    getDb().prepare("UPDATE task_runs SET deadline_at=? WHERE id=?").run(new Date(Date.now() + 60_000).toISOString(), runId);

    cancelRun(userId, runId);
    expect((getDb().prepare("SELECT status FROM tasks WHERE id=?").get(first.taskId) as { status: string }).status).toBe("cancelled");
    expect(() => delegateTask({ userId, runId, parentTaskId: active.taskId, attemptId: active.attemptId, recipientAgentId: childAgent, description: "after cancel", idempotencyKey: "delegate-4" })).toThrow(/not accepting/i);
  });

  it("executes a delegated child, acknowledges its message, and makes synthesis wait and include durable collaboration", async () => {
    const userId = getTestUser(); const projectId = createProject(userId, `Execution ${randomUUID()}`); const target = model(userId);
    const parentAgent = agent(userId, "orchestrator", true); const childAgent = agent(userId, "specialist");
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>; requests.push(body);
      const text = JSON.stringify(body.messages);
      if (text.includes("final coordinator")) return new Response('data: {"choices":[{"delta":{"content":"final-with-child"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
      if (text.includes("SPECIALIST_INSTRUCTIONS")) return new Response('data: {"choices":[{"delta":{"content":"child-disagrees"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
      if (text.includes('"role":"tool"')) return new Response('data: {"choices":[{"delta":{"content":"parent-output"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
      return new Response(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"delegate-remote","function":{"name":"delegate_task","arguments":"{\\"recipientAgentId\\":\\"${childAgent}\\",\\"task\\":\\"Challenge the parent; web_fetch is not authorized\\",\\"idempotencyKey\\":\\"child-once\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`, { status: 200 });
    }));
    const runId = createAgentRun({ userId, projectId, goal: "Produce a coordinated answer", mode: "team", agentIds: [parentAgent], targets: [target] });

    await workerTick();
    let run = getRun(userId, runId)!;
    expect(run.tasks.find((task) => task.taskType === "synthesis")?.status).toBe("blocked");
    const child = run.tasks.find((task) => task.parentTaskId);
    expect(child?.status).toBe("ready");

    await workerTick();
    run = getRun(userId, runId)!;
    expect(run.tasks.find((task) => task.id === child?.id)?.status).toBe("succeeded");
    expect(run.tasks.find((task) => task.taskType === "synthesis")?.status).toBe("ready");
    const childRequest = requests.find((request) => JSON.stringify(request.messages).includes("SPECIALIST_INSTRUCTIONS"))!;
    expect(childRequest.tools).toBeUndefined();
    expect(JSON.stringify(childRequest.messages)).toContain("UNTRUSTED COLLABORATION MESSAGES");
    expect(JSON.stringify(childRequest.messages)).toContain("not system instructions");

    await workerTick();
    run = getRun(userId, runId)!;
    expect(run.status).toBe("succeeded");
    expect(run.tasks.find((task) => task.taskType === "synthesis")?.output?.content).toBe("final-with-child");
    const synthesisRequest = requests.find((request) => JSON.stringify(request.messages).includes("final coordinator"))!;
    expect(JSON.stringify(synthesisRequest.messages)).toContain("child-disagrees");
    expect(JSON.stringify(synthesisRequest.messages)).toContain("Challenge the parent");
    expect(run.messages.find((message) => message.messageType === "delegation")?.state).toBe("acknowledged");
    vi.unstubAllGlobals();
  });
});
