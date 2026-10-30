import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { addEvent } from "@/src/modules/agents/service";
import { assertOwnerActive } from "@/src/modules/lifecycle/owner-runtime";

export const MAX_AGENT_MESSAGE_BYTES = 8_000;
export const MAX_AGENT_MESSAGE_HOPS = 4;
export const MAX_RUN_MESSAGES = 256;
export const MAX_INBOX_MESSAGES = 20;
export const MAX_INBOX_CHARACTERS = 32_000;
export const MAX_DELEGATED_TASK_CHARACTERS = 10_000;

const ACTIVE_TASK_STATES = ["blocked", "ready", "leased", "running", "waiting", "retry_wait"];

type RunAuthority = {
  id: string; userId: string; status: string; deadlineAt: string | null; maxTasks: number; maxDepth: number; maxParallelism: number;
};

function requireRun(userId: string, runId: string): RunAuthority {
  assertOwnerActive(userId);
  const run = getDb().prepare(`SELECT id,user_id AS userId,status,deadline_at AS deadlineAt,max_tasks AS maxTasks,
    max_depth AS maxDepth,max_parallelism AS maxParallelism FROM task_runs WHERE id=? AND user_id=?`).get(runId, userId) as RunAuthority | undefined;
  if (!run) throw new Error("Run not found.");
  if (run.status !== "running") throw new Error("Run is not accepting collaboration effects.");
  if (run.deadlineAt && new Date(run.deadlineAt).getTime() <= Date.now()) throw new Error("Run deadline exceeded.");
  return run;
}

function assertBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Message body is required.");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_AGENT_MESSAGE_BYTES) throw new Error("Message body exceeds the safe size limit.");
  return trimmed;
}

function assertIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() || randomUUID();
  if (key.length > 200) throw new Error("Idempotency key is too long.");
  return key;
}

function expireMessages(runId: string): void {
  const now = new Date().toISOString();
  getDb().prepare(`UPDATE agent_messages SET state='expired',updated_at=?
    WHERE run_id=? AND state='pending' AND expires_at<=?`).run(now, runId, now);
}

function resolveRecipientTask(runId: string, agentId: string, requestedTaskId?: string): string {
  const placeholders = ACTIVE_TASK_STATES.map(() => "?").join(",");
  const params = requestedTaskId ? [requestedTaskId, runId, agentId, ...ACTIVE_TASK_STATES] : [runId, agentId, ...ACTIVE_TASK_STATES];
  const sql = requestedTaskId
    ? `SELECT id FROM tasks WHERE id=? AND run_id=? AND assigned_agent_id=? AND status IN (${placeholders})`
    : `SELECT id FROM tasks WHERE run_id=? AND assigned_agent_id=? AND status IN (${placeholders}) ORDER BY depth DESC,created_at DESC LIMIT 1`;
  const task = getDb().prepare(sql).get(...params) as { id: string } | undefined;
  if (!task) throw new Error("Recipient agent has no active participating task in this run.");
  return task.id;
}

function requireParticipant(runId: string, agentId: string): void {
  const participant = getDb().prepare("SELECT 1 FROM run_agent_participants WHERE run_id=? AND agent_id=?").get(runId, agentId);
  if (!participant) throw new Error("Recipient agent is not participating in this run.");
}

function modelSender(input: SendAgentMessageInput): { agentId: string; taskId: string; attemptId: string } | null {
  if (!input.senderTaskId && !input.senderAttemptId && !input.senderAgentId) return null;
  if (!input.senderTaskId || !input.senderAttemptId || !input.senderAgentId) throw new Error("Model sender authority is incomplete.");
  const row = getDb().prepare(`SELECT t.assigned_agent_id AS agentId FROM tasks t
    JOIN task_attempts ta ON ta.task_id=t.id AND ta.id=? AND ta.status='running'
    WHERE t.id=? AND t.run_id=? AND t.assigned_agent_id=? AND t.status IN ('leased','running')`)
    .get(input.senderAttemptId, input.senderTaskId, input.runId, input.senderAgentId) as { agentId: string } | undefined;
  if (!row) throw new Error("Message sender authority is no longer active.");
  return { agentId: row.agentId, taskId: input.senderTaskId, attemptId: input.senderAttemptId };
}

export type SendAgentMessageInput = {
  userId: string; runId: string; recipientAgentId: string; recipientTaskId?: string; body: string;
  senderAgentId?: string; senderTaskId?: string; senderAttemptId?: string; messageType?: "coordination" | "reply";
  correlationId?: string; replyToId?: string; hopCount?: number; idempotencyKey?: string; ttlSeconds?: number;
};

export function sendAgentMessage(input: SendAgentMessageInput): { messageId: string } {
  const run = requireRun(input.userId, input.runId);
  const body = assertBody(input.body);
  const key = assertIdempotencyKey(input.idempotencyKey);
  const sender = modelSender(input);
  requireParticipant(input.runId, input.recipientAgentId);
  const recipientTaskId = resolveRecipientTask(input.runId, input.recipientAgentId, input.recipientTaskId);
  expireMessages(input.runId);
  const existing = sender
    ? getDb().prepare("SELECT id,recipient_agent_id AS recipientAgentId,body_json AS bodyJson FROM agent_messages WHERE sender_task_id=? AND idempotency_key=?").get(sender.taskId, key)
    : getDb().prepare("SELECT id,recipient_agent_id AS recipientAgentId,body_json AS bodyJson FROM agent_messages WHERE run_id=? AND sender_agent_id IS NULL AND idempotency_key=?").get(input.runId, key);
  if (existing) {
    const row = existing as { id: string; recipientAgentId: string; bodyJson: string };
    if (row.recipientAgentId !== input.recipientAgentId || (JSON.parse(row.bodyJson) as { text: string }).text !== body) throw new Error("Idempotency key was already used for different message content.");
    return { messageId: row.id };
  }
  const reply = input.replyToId ? getDb().prepare(`SELECT id,sender_agent_id AS senderAgentId,recipient_agent_id AS recipientAgentId,
    correlation_id AS correlationId,hop_count AS hopCount FROM agent_messages WHERE id=? AND run_id=?`).get(input.replyToId, input.runId) as {
      id: string; senderAgentId: string | null; recipientAgentId: string; correlationId: string; hopCount: number;
    } | undefined : undefined;
  if (input.replyToId && !reply) throw new Error("Reply target is not part of this run.");
  if (reply) {
    if (reply.senderAgentId !== input.recipientAgentId) throw new Error("Reply recipient does not match the original sender.");
    if (sender && reply.recipientAgentId !== sender.agentId) throw new Error("Reply sender does not match the original recipient.");
    if (input.correlationId && input.correlationId !== reply.correlationId) throw new Error("Reply correlation does not match the conversation.");
  }
  const hopCount = reply ? reply.hopCount + 1 : input.hopCount ?? 0;
  if (!Number.isInteger(hopCount) || hopCount < 0 || hopCount > MAX_AGENT_MESSAGE_HOPS) throw new Error("Message hop limit exceeded.");
  const count = getDb().prepare("SELECT count(*) AS count FROM agent_messages WHERE run_id=?").get(input.runId) as { count: number };
  if (count.count >= MAX_RUN_MESSAGES) throw new Error("Run message limit reached.");
  const ttlSeconds = Math.max(1, Math.min(input.ttlSeconds ?? 3_600, 86_400));
  const expiresMs = Math.min(Date.now() + ttlSeconds * 1_000, run.deadlineAt ? new Date(run.deadlineAt).getTime() : Number.POSITIVE_INFINITY);
  const now = new Date().toISOString();
  const messageId = randomUUID();
  const correlationId = reply?.correlationId ?? input.correlationId?.slice(0, 200) ?? randomUUID();
  const trustLabel = sender ? "untrusted_agent" : "explicit_user";
  getDb().transaction(() => {
    getDb().prepare(`INSERT INTO agent_messages
      (id,run_id,task_id,sender_agent_id,recipient_agent_id,message_type,correlation_id,reply_to_id,hop_count,body_json,created_at,
       sender_task_id,sender_attempt_id,recipient_task_id,state,trust_label,idempotency_key,expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?, 'pending',?,?,?,?)`)
      .run(messageId, input.runId, sender?.taskId ?? recipientTaskId, sender?.agentId ?? null, input.recipientAgentId,
        input.messageType ?? (reply ? "reply" : "coordination"), correlationId, reply?.id ?? null, hopCount, JSON.stringify({ text: body }), now,
        sender?.taskId ?? null, sender?.attemptId ?? null, recipientTaskId, trustLabel, key, new Date(expiresMs).toISOString(), now);
    addEvent(getDb(), input.runId, recipientTaskId, "AgentMessageSent", { messageId, correlationId, senderAgentId: sender?.agentId ?? null, recipientAgentId: input.recipientAgentId, trustLabel, hopCount }, { actorType: sender ? "agent" : "user", actorId: sender?.agentId ?? input.userId, correlationId });
  })();
  writeAudit({ userId: input.userId, action: sender ? "agent.message.sent" : "agent.message.human_sent", resourceType: "agent_message", resourceId: messageId, outcome: "success", metadata: { runId: input.runId, recipientAgentId: input.recipientAgentId, trustLabel } });
  return { messageId };
}

export function replyAgentMessage(input: SendAgentMessageInput & { replyToId: string }): { messageId: string } {
  return sendAgentMessage({ ...input, messageType: "reply" });
}

export type PendingAgentMessage = { id: string; senderName: string; trustLabel: string; correlationId: string; replyToId: string | null; body: string; createdAt: string };

export function pendingAgentMessages(input: { userId: string; runId: string; taskId: string; recipientAgentId: string }): PendingAgentMessage[] {
  requireRun(input.userId, input.runId);
  const task = getDb().prepare("SELECT 1 FROM tasks WHERE id=? AND run_id=? AND assigned_agent_id=? AND status IN ('leased','running')").get(input.taskId, input.runId, input.recipientAgentId);
  if (!task) throw new Error("Message recipient authority is no longer active.");
  expireMessages(input.runId);
  const rows = getDb().prepare(`SELECT m.id,COALESCE(a.name,'Human owner') AS senderName,m.trust_label AS trustLabel,
    m.correlation_id AS correlationId,m.reply_to_id AS replyToId,m.body_json AS bodyJson,m.created_at AS createdAt
    FROM agent_messages m LEFT JOIN agents a ON a.id=m.sender_agent_id
    WHERE m.run_id=? AND m.recipient_agent_id=? AND m.recipient_task_id=? AND m.state='pending' AND m.expires_at>?
    ORDER BY m.created_at,m.id LIMIT ?`).all(input.runId, input.recipientAgentId, input.taskId, new Date().toISOString(), MAX_INBOX_MESSAGES) as Array<{
      id: string; senderName: string; trustLabel: string; correlationId: string; replyToId: string | null; bodyJson: string; createdAt: string;
    }>;
  let characters = 0;
  const messages: PendingAgentMessage[] = [];
  for (const row of rows) {
    const body = String((JSON.parse(row.bodyJson) as { text?: unknown }).text ?? "");
    if (characters + body.length > MAX_INBOX_CHARACTERS) break;
    characters += body.length;
    messages.push({ ...row, body });
  }
  return messages;
}

export function acknowledgeAgentMessages(input: { userId: string; runId: string; taskId: string; recipientAgentId: string; messageIds: string[] }): void {
  if (!input.messageIds.length) return;
  const run = getDb().prepare("SELECT 1 FROM task_runs WHERE id=? AND user_id=?").get(input.runId, input.userId);
  if (!run) throw new Error("Run not found.");
  const now = new Date().toISOString();
  const placeholders = input.messageIds.map(() => "?").join(",");
  getDb().transaction(() => {
    const changed = getDb().prepare(`UPDATE agent_messages SET state='acknowledged',delivered_at=COALESCE(delivered_at,?),acknowledged_at=?,updated_at=?
      WHERE run_id=? AND recipient_task_id=? AND recipient_agent_id=? AND state='pending' AND expires_at>? AND id IN (${placeholders})`)
      .run(now, now, now, input.runId, input.taskId, input.recipientAgentId, now, ...input.messageIds);
    if (changed.changes !== input.messageIds.length) throw new Error("Message acknowledgement lost its delivery fence.");
    for (const messageId of input.messageIds) addEvent(getDb(), input.runId, input.taskId, "AgentMessageAcknowledged", { messageId, recipientAgentId: input.recipientAgentId }, { actorType: "agent", actorId: input.recipientAgentId });
  })();
}

export type AgentMessageView = Record<string, unknown> & { id: string; messageType: string; state: string; body: { text?: string } };

export function listAgentMessages(userId: string, runId: string): AgentMessageView[] | null {
  const run = getDb().prepare("SELECT 1 FROM task_runs WHERE id=? AND user_id=?").get(runId, userId);
  if (!run) return null;
  expireMessages(runId);
  return getDb().prepare(`SELECT m.id,m.sender_agent_id AS senderAgentId,sa.name AS senderName,m.recipient_agent_id AS recipientAgentId,
    ra.name AS recipientName,m.sender_task_id AS senderTaskId,m.recipient_task_id AS recipientTaskId,m.message_type AS messageType,
    m.correlation_id AS correlationId,m.reply_to_id AS replyToId,m.hop_count AS hopCount,m.body_json AS bodyJson,m.state,
    m.trust_label AS trustLabel,m.expires_at AS expiresAt,m.delivered_at AS deliveredAt,m.acknowledged_at AS acknowledgedAt,m.created_at AS createdAt
    FROM agent_messages m LEFT JOIN agents sa ON sa.id=m.sender_agent_id JOIN agents ra ON ra.id=m.recipient_agent_id
    WHERE m.run_id=? ORDER BY m.created_at,m.id LIMIT ?`).all(runId, MAX_RUN_MESSAGES).map((value): AgentMessageView => {
      const row = value as Record<string, unknown> & { id: string; messageType: string; state: string; bodyJson: string };
      const { bodyJson, ...rest } = row;
      return { ...rest, body: JSON.parse(bodyJson) as { text?: string } };
    });
}

export function listParticipatingAgents(userId: string, runId: string) {
  const run = getDb().prepare("SELECT 1 FROM task_runs WHERE id=? AND user_id=?").get(runId, userId);
  if (!run) return null;
  return getDb().prepare(`SELECT p.agent_id AS id,a.name,a.role,p.source,p.introduced_by_task_id AS introducedByTaskId
    FROM run_agent_participants p JOIN agents a ON a.id=p.agent_id WHERE p.run_id=? ORDER BY p.created_at,a.name`).all(runId);
}

export type DelegateTaskInput = {
  userId: string; runId: string; parentTaskId: string; attemptId: string; recipientAgentId: string;
  description: string; idempotencyKey: string; correlationId?: string;
};

export function delegateTask(input: DelegateTaskInput): { taskId: string; messageId: string } {
  const run = requireRun(input.userId, input.runId);
  const description = input.description.trim();
  if (!description || description.length > MAX_DELEGATED_TASK_CHARACTERS) throw new Error("Delegated task description is outside the safe size limit.");
  const key = assertIdempotencyKey(input.idempotencyKey);
  const fingerprint = createHash("sha256").update(`${input.parentTaskId}\0${input.recipientAgentId}\0${description}`).digest("hex");
  const existing = getDb().prepare("SELECT child_task_id AS taskId,message_id AS messageId,fingerprint FROM task_delegations WHERE parent_task_id=? AND (fingerprint=? OR idempotency_key=?)")
    .get(input.parentTaskId, fingerprint, key) as { taskId: string; messageId: string; fingerprint: string } | undefined;
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error("Idempotency key was already used for a different delegation.");
    return { taskId: existing.taskId, messageId: existing.messageId };
  }
  const parent = getDb().prepare(`SELECT t.id,t.depth,t.assigned_agent_id AS senderAgentId,t.input_json AS inputJson,t.task_type AS taskType
    FROM tasks t JOIN task_attempts ta ON ta.task_id=t.id AND ta.id=? AND ta.status='running'
    WHERE t.id=? AND t.run_id=? AND t.status IN ('leased','running')`).get(input.attemptId, input.parentTaskId, input.runId) as {
      id: string; depth: number; senderAgentId: string; inputJson: string; taskType: string;
    } | undefined;
  if (!parent || parent.taskType !== "model_agent") throw new Error("Delegation authority is no longer active.");
  if (parent.depth + 1 > run.maxDepth) throw new Error("Run delegation depth limit reached.");
  const taskCount = getDb().prepare("SELECT count(*) AS count FROM tasks WHERE run_id=?").get(input.runId) as { count: number };
  if (taskCount.count >= run.maxTasks) throw new Error("Run task limit reached.");
  const synthesis = getDb().prepare("SELECT id FROM tasks WHERE run_id=? AND task_type='synthesis' AND status='blocked'").get(input.runId) as { id: string } | undefined;
  if (!synthesis) throw new Error("Final synthesis is no longer blocked for delegation.");
  const agent = getDb().prepare(`SELECT id,name,role,instructions,allowed_tools_json AS allowedToolsJson,permission_policy_json AS permissionPolicyJson,
    budget_json AS budgetJson,max_duration_seconds AS maxDurationSeconds,max_turns AS maxTurns,output_schema_json AS outputSchemaJson,
    completion_criteria AS completionCriteria FROM agents WHERE id=? AND user_id=?`).get(input.recipientAgentId, input.userId) as {
      id: string; name: string; role: string; instructions: string; allowedToolsJson: string; permissionPolicyJson: string; budgetJson: string;
      maxDurationSeconds: number; maxTurns: number; outputSchemaJson: string | null; completionCriteria: string;
    } | undefined;
  if (!agent) throw new Error("Delegated recipient agent was not found.");
  const parentInput = JSON.parse(parent.inputJson) as { target?: unknown; goal?: string };
  if (!parentInput.target) throw new Error("Parent task has no model target to inherit.");
  const now = new Date().toISOString();
  const taskId = randomUUID();
  const messageId = randomUUID();
  const delegationId = randomUUID();
  const correlationId = input.correlationId?.slice(0, 200) || randomUUID();
  const expiresAt = run.deadlineAt ?? new Date(Date.now() + 3_600_000).toISOString();
  getDb().transaction(() => {
    getDb().prepare(`INSERT OR IGNORE INTO run_agent_participants
      (run_id,agent_id,source,introduced_by_task_id,instructions,allowed_tools_json,permission_policy_json,budget_json,max_duration_seconds,max_turns,output_schema_json,completion_criteria,created_at)
      VALUES (?,?,'delegated',?,?,?,?,?,?,?,?,?,?)`)
      .run(input.runId, agent.id, parent.id, agent.instructions, agent.allowedToolsJson, agent.permissionPolicyJson, agent.budgetJson, agent.maxDurationSeconds, agent.maxTurns, agent.outputSchemaJson, agent.completionCriteria, now);
    getDb().prepare(`INSERT INTO tasks
      (id,run_id,parent_task_id,assigned_agent_id,task_key,title,description,task_type,status,depth,priority,ready_at,input_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'model_agent','ready',?,60,?,?,?,?)`)
      .run(taskId, input.runId, parent.id, agent.id, `delegate-${fingerprint.slice(0, 24)}`, `${agent.name}: ${description.slice(0, 72)}`, description,
        parent.depth + 1, now, JSON.stringify({ goal: description, parentGoal: parentInput.goal, instructions: agent.instructions,
          completionCriteria: agent.completionCriteria, target: parentInput.target, allowedTools: JSON.parse(agent.allowedToolsJson),
          permissionPolicy: JSON.parse(agent.permissionPolicyJson), budget: JSON.parse(agent.budgetJson), maxTurns: agent.maxTurns,
          maxDurationSeconds: agent.maxDurationSeconds, outputSchema: agent.outputSchemaJson ? JSON.parse(agent.outputSchemaJson) : null }), now, now);
    getDb().prepare("INSERT INTO task_dependencies (task_id,depends_on_task_id,predicate,required) VALUES (?,?,'terminal',1)").run(synthesis.id, taskId);
    getDb().prepare(`INSERT INTO agent_messages
      (id,run_id,task_id,sender_agent_id,recipient_agent_id,message_type,correlation_id,hop_count,body_json,created_at,sender_task_id,sender_attempt_id,
       recipient_task_id,state,trust_label,idempotency_key,expires_at,updated_at)
      VALUES (?,?,?,?,?,'delegation',?,0,?,?, ?,?,?, 'pending','untrusted_agent',?,?,?)`)
      .run(messageId, input.runId, taskId, parent.senderAgentId, agent.id, correlationId, JSON.stringify({ text: description }), now,
        parent.id, input.attemptId, taskId, `delegation:${key}`, expiresAt, now);
    getDb().prepare(`INSERT INTO task_delegations (id,run_id,parent_task_id,child_task_id,recipient_agent_id,message_id,fingerprint,idempotency_key,correlation_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(delegationId, input.runId, parent.id, taskId, agent.id, messageId, fingerprint, key, correlationId, now);
    addEvent(getDb(), input.runId, taskId, "TaskCreated", { title: agent.name, status: "ready", parentTaskId: parent.id, delegated: true });
    addEvent(getDb(), input.runId, parent.id, "TaskDelegated", { taskId, messageId, recipientAgentId: agent.id, correlationId, depth: parent.depth + 1 }, { actorType: "agent", actorId: parent.senderAgentId, correlationId });
    addEvent(getDb(), input.runId, taskId, "AgentMessageSent", { messageId, correlationId, senderAgentId: parent.senderAgentId, recipientAgentId: agent.id, trustLabel: "untrusted_agent", hopCount: 0 }, { actorType: "agent", actorId: parent.senderAgentId, correlationId });
  })();
  writeAudit({ userId: input.userId, action: "agent.task.delegated", resourceType: "task", resourceId: taskId, outcome: "success", metadata: { runId: input.runId, parentTaskId: parent.id, recipientAgentId: agent.id } });
  return { taskId, messageId };
}
