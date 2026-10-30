import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { AGENT_TEMPLATES } from "@/src/modules/agents/templates";
import { INTERNAL_ORCHESTRATION_TOOL_NAMES, MAX_AGENT_TURNS, normalizeAllowedTools, permissionPolicySchema, validateOutputSchema } from "@/src/modules/agents/policy";
import { normalizeAgentBudget } from "@/src/modules/gateway/budgets";
import type { ChatTarget } from "@/src/modules/workspace/chat";
import { assertOwnerActive } from "@/src/modules/lifecycle/owner-runtime";

export type CreateAgentInput = {
  name: string;
  role: string;
  instructions: string;
  allowedTools?: string[];
  permissionPolicy?: unknown;
  budget?: unknown;
  maxDurationSeconds?: number;
  maxTurns?: number;
  outputSchema?: unknown;
  completionCriteria?: string;
};

export function ensureTemplates(userId: string): void {
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO agents
    (id, user_id, slug, name, role, instructions, allowed_tools_json, permission_policy_json, max_duration_seconds, max_turns, completion_criteria, is_template, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8, ?, 1, ?, ?)`);
  const now = new Date().toISOString();
  const internalPolicy = { mode: "read_only", maxToolCalls: 4, maxMessages: 0, maxDelegations: 0 };
  db.transaction(() => {
    for (const template of AGENT_TEMPLATES) insert.run(randomUUID(), userId, template.slug, template.name, template.role, template.instructions, JSON.stringify(template.tools), JSON.stringify(internalPolicy), 600, template.completionCriteria, now, now);
  })();
}

export function listAgents(userId: string) {
  ensureTemplates(userId);
  return getDb().prepare(`SELECT id, slug, name, role, instructions, allowed_tools_json AS allowedToolsJson,
    permission_policy_json AS permissionPolicyJson, budget_json AS budgetJson, max_duration_seconds AS maxDurationSeconds,
    max_turns AS maxTurns, memory_scope AS memoryScope, output_schema_json AS outputSchemaJson,
    completion_criteria AS completionCriteria, is_template AS isTemplate,
    created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE user_id=? ORDER BY is_template DESC, name`).all(userId) as Array<Record<string, unknown>>;
}

export function createAgent(userId: string, input: CreateAgentInput): string {
  assertOwnerActive(userId);
  const allowedTools = normalizeAllowedTools(input.allowedTools ?? []);
  const permissionPolicy = permissionPolicySchema.parse(input.permissionPolicy ?? {});
  if (allowedTools.some((tool) => (INTERNAL_ORCHESTRATION_TOOL_NAMES as readonly string[]).includes(tool)) && permissionPolicy.mode !== "read_only_or_internal") {
    throw new Error("Internal orchestration tools require read_only_or_internal policy.");
  }
  const maxDurationSeconds = input.maxDurationSeconds ?? 600;
  const maxTurns = input.maxTurns ?? 8;
  if (maxDurationSeconds < 10 || maxDurationSeconds > 86_400) throw new Error("Agent duration is outside the safe limit.");
  if (maxTurns < 1 || maxTurns > MAX_AGENT_TURNS) throw new Error("Agent turns are outside the safe limit.");
  const outputSchema = validateOutputSchema(input.outputSchema);
  const budget = normalizeAgentBudget(input.budget);
  const id = randomUUID();
  const slug = `custom-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50)}-${id.slice(0, 6)}`;
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO agents
    (id, user_id, slug, name, role, instructions, allowed_tools_json, permission_policy_json, budget_json, max_duration_seconds, max_turns, output_schema_json, completion_criteria, is_template, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(id, userId, slug, input.name, input.role, input.instructions, JSON.stringify(allowedTools), JSON.stringify(permissionPolicy), JSON.stringify(budget), maxDurationSeconds, maxTurns, outputSchema ? JSON.stringify(outputSchema) : null, input.completionCriteria ?? "", now, now);
  writeAudit({ userId, action: "agent.created", resourceType: "agent", resourceId: id, outcome: "success" });
  return id;
}

export function createAgentRun(input: {
  userId: string; projectId: string; goal: string; mode: "team" | "review" | "research" | "engineering";
  agentIds: string[]; targets: ChatTarget[]; maxParallelism?: number; deadlineSeconds?: number;
}): string {
  assertOwnerActive(input.userId);
  ensureTemplates(input.userId);
  if (input.agentIds.length < 1 || input.agentIds.length > 8 || new Set(input.agentIds).size !== input.agentIds.length) throw new Error("Select between one and eight unique agents.");
  if (input.targets.length < 1 || input.targets.length > 4 || new Set(input.targets.map((target) => `${target.connectionId}\0${target.modelId}`)).size !== input.targets.length) throw new Error("Select between one and four unique model targets.");
  if ((input.maxParallelism ?? 3) < 1 || (input.maxParallelism ?? 3) > 8) throw new Error("Parallelism is outside the safe limit.");
  const db = getDb();
  const project = db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").get(input.projectId, input.userId);
  if (!project) throw new Error("Project not found.");
  const agents = input.agentIds.map((id) => db.prepare(`SELECT id,name,role,instructions,completion_criteria AS completionCriteria,
    allowed_tools_json AS allowedToolsJson,permission_policy_json AS permissionPolicyJson,budget_json AS budgetJson,
    max_duration_seconds AS maxDurationSeconds,max_turns AS maxTurns,
    output_schema_json AS outputSchemaJson FROM agents WHERE id=? AND user_id=?`).get(id, input.userId) as {
      id: string; name: string; role: string; instructions: string; completionCriteria: string; allowedToolsJson: string;
      permissionPolicyJson: string; budgetJson: string; maxDurationSeconds: number; maxTurns: number; outputSchemaJson: string | null;
    } | undefined);
  if (agents.some((agent) => !agent)) throw new Error("One or more agents were not found.");
  for (const target of input.targets) {
    const found = db.prepare(`SELECT 1 FROM models m JOIN provider_connections c ON c.id=m.connection_id
      WHERE c.user_id=? AND c.id=? AND c.status='connected' AND m.provider_model_id=? AND m.availability='available'`).get(input.userId, target.connectionId, target.modelId);
    if (!found) throw new Error(`Model ${target.modelId} is not available.`);
  }
  const now = new Date().toISOString();
  const runId = randomUUID();
  const title = input.goal.trim().slice(0, 90);
  db.transaction(() => {
    db.prepare(`INSERT INTO task_runs
      (id, user_id, project_id, title, goal, mode, status, max_parallelism, max_tasks, max_depth, deadline_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, 32, 4, ?, ?, ?)`)
      .run(runId, input.userId, input.projectId, title, input.goal, input.mode, input.maxParallelism ?? 3, new Date(Date.now() + (input.deadlineSeconds ?? 3600) * 1000).toISOString(), now, now);
    const taskIds: string[] = [];
    agents.forEach((agent, index) => {
      const taskId = randomUUID();
      taskIds.push(taskId);
      const target = input.targets[index % input.targets.length]!;
      db.prepare(`INSERT INTO tasks
        (id, run_id, assigned_agent_id, task_key, title, description, task_type, status, depth, priority, ready_at, input_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'model_agent', 'ready', 0, 50, ?, ?, ?, ?)`)
        .run(taskId, runId, agent!.id, `agent-${index + 1}`, agent!.name, `Independent ${agent!.role} analysis`, now,
          JSON.stringify({ goal: input.goal, instructions: agent!.instructions, completionCriteria: agent!.completionCriteria, target,
            allowedTools: JSON.parse(agent!.allowedToolsJson), permissionPolicy: JSON.parse(agent!.permissionPolicyJson), budget: JSON.parse(agent!.budgetJson),
            maxDurationSeconds: agent!.maxDurationSeconds, maxTurns: agent!.maxTurns,
            outputSchema: agent!.outputSchemaJson ? JSON.parse(agent!.outputSchemaJson) : null }), now, now);
      db.prepare(`INSERT INTO run_agent_participants
        (run_id,agent_id,source,instructions,allowed_tools_json,permission_policy_json,budget_json,max_duration_seconds,max_turns,output_schema_json,completion_criteria,created_at)
        VALUES (?,?,'initial',?,?,?,?,?,?,?,?,?)`)
        .run(runId, agent!.id, agent!.instructions, agent!.allowedToolsJson, agent!.permissionPolicyJson, agent!.budgetJson,
          agent!.maxDurationSeconds, agent!.maxTurns, agent!.outputSchemaJson, agent!.completionCriteria, now);
      addEvent(db, runId, taskId, "TaskCreated", { title: agent!.name, status: "ready" });
    });
    const synthesisId = randomUUID();
    db.prepare(`INSERT INTO tasks
      (id, run_id, task_key, title, description, task_type, status, depth, priority, input_json, created_at, updated_at)
      VALUES (?, ?, 'synthesis', 'Synthesis and verification', 'Reconcile independent outputs, disagreements, and evidence.', 'synthesis', 'blocked', 1, 90, ?, ?, ?)`)
      .run(synthesisId, runId, JSON.stringify({ goal: input.goal, target: input.targets[0], mode: input.mode, allowedTools: [], permissionPolicy: { mode: "read_only", maxToolCalls: 0 }, maxTurns: 1, outputSchema: null }), now, now);
    const dependency = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, predicate, required) VALUES (?, ?, 'terminal', 1)");
    taskIds.forEach((taskId) => dependency.run(synthesisId, taskId));
    addEvent(db, runId, synthesisId, "TaskCreated", { title: "Synthesis and verification", status: "blocked", dependencies: taskIds });
    addEvent(db, runId, null, "RunStarted", { mode: input.mode, taskCount: taskIds.length + 1 });
  })();
  writeAudit({ userId: input.userId, action: "agent.run.created", resourceType: "task_run", resourceId: runId, outcome: "success", metadata: { mode: input.mode, agentCount: agents.length } });
  return runId;
}

export function addEvent(
  db: ReturnType<typeof getDb>, runId: string, taskId: string | null, eventType: string, payload: Record<string, unknown>,
  actor: { actorType?: "orchestrator" | "agent" | "user"; actorId?: string | null; correlationId?: string | null; causationId?: string | null } = {},
): void {
  db.prepare(`INSERT INTO task_events (id, run_id, task_id, event_type, actor_type, actor_id, correlation_id, causation_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), runId, taskId, eventType, actor.actorType ?? "orchestrator", actor.actorId ?? null,
      actor.correlationId ?? null, actor.causationId ?? null, JSON.stringify(payload), new Date().toISOString());
}

type RunRecord = {
  id: string; projectId: string | null; title: string; goal: string; mode: string; status: string;
  maxParallelism: number; maxTasks: number; maxDepth: number; deadlineAt: string | null; cancelRequestedAt: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
};

type TaskRecord = {
  id: string; parentTaskId: string | null; assignedAgentId: string | null; agentName: string | null;
  taskKey: string; title: string; description: string; taskType: string; status: string; depth: number;
  priority: number; attemptCount: number; maxAttempts: number; outputJson: string | null;
  errorCode: string | null; errorMessage: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
};

type RunMessageRecord = {
  id: string; senderAgentId: string | null; senderName: string | null; recipientAgentId: string; recipientName: string | null;
  senderTaskId: string | null; recipientTaskId: string | null; messageType: string; correlationId: string; replyToId: string | null;
  hopCount: number; bodyJson: string; state: string; trustLabel: string; expiresAt: string; deliveredAt: string | null;
  acknowledgedAt: string | null; createdAt: string;
};

export function getRun(userId: string, runId: string) {
  const db = getDb();
  const run = db.prepare(`SELECT id, project_id AS projectId, title, goal, mode, status, max_parallelism AS maxParallelism,
    max_tasks AS maxTasks,max_depth AS maxDepth,
    deadline_at AS deadlineAt, cancel_requested_at AS cancelRequestedAt, created_at AS createdAt,
    updated_at AS updatedAt, completed_at AS completedAt FROM task_runs WHERE id=? AND user_id=?`).get(runId, userId) as RunRecord | undefined;
  if (!run) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE agent_messages SET state='expired',updated_at=? WHERE run_id=? AND state='pending' AND expires_at<=?").run(now, runId, now);
  const tasks = db.prepare(`SELECT t.id, t.parent_task_id AS parentTaskId, t.assigned_agent_id AS assignedAgentId, a.name AS agentName,
    t.task_key AS taskKey, t.title, t.description, t.task_type AS taskType, t.status, t.depth, t.priority,
    t.attempt_count AS attemptCount, t.max_attempts AS maxAttempts, t.output_json AS outputJson,
    t.error_code AS errorCode, t.error_message AS errorMessage, t.created_at AS createdAt, t.updated_at AS updatedAt,
    t.completed_at AS completedAt FROM tasks t LEFT JOIN agents a ON a.id=t.assigned_agent_id WHERE t.run_id=? ORDER BY t.depth, t.priority DESC, t.created_at`).all(runId) as TaskRecord[];
  const dependencies = db.prepare(`SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId, d.predicate, d.required
    FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.run_id=?`).all(runId);
  const messages = db.prepare(`SELECT m.id,m.sender_agent_id AS senderAgentId,sa.name AS senderName,m.recipient_agent_id AS recipientAgentId,
    ra.name AS recipientName,m.sender_task_id AS senderTaskId,m.recipient_task_id AS recipientTaskId,m.message_type AS messageType,
    m.correlation_id AS correlationId,m.reply_to_id AS replyToId,m.hop_count AS hopCount,m.body_json AS bodyJson,m.state,
    m.trust_label AS trustLabel,m.expires_at AS expiresAt,m.delivered_at AS deliveredAt,m.acknowledged_at AS acknowledgedAt,m.created_at AS createdAt
    FROM agent_messages m LEFT JOIN agents sa ON sa.id=m.sender_agent_id LEFT JOIN agents ra ON ra.id=m.recipient_agent_id
    WHERE m.run_id=? ORDER BY m.created_at,m.id LIMIT 256`).all(runId) as RunMessageRecord[];
  const messageViews = messages.map(({ bodyJson, ...message }) => ({ ...message, body: JSON.parse(bodyJson) as { text?: string } }));
  const events = db.prepare(`SELECT sequence,id,task_id AS taskId,event_type AS eventType,actor_type AS actorType,actor_id AS actorId,
    correlation_id AS correlationId,causation_id AS causationId,payload_json AS payloadJson,created_at AS createdAt
    FROM task_events WHERE run_id=? ORDER BY sequence DESC LIMIT 200`).all(runId).map((value) => {
      const event = value as Record<string, unknown>;
      return { ...event, payload: JSON.parse(String(event.payloadJson)), payloadJson: undefined };
    }).reverse();
  const participants = db.prepare(`SELECT p.agent_id AS id,a.name,a.role,p.source,p.introduced_by_task_id AS introducedByTaskId
    FROM run_agent_participants p JOIN agents a ON a.id=p.agent_id WHERE p.run_id=? ORDER BY p.created_at,a.name`).all(runId);
  return { ...run, tasks: tasks.map((task) => ({ ...task, output: task.outputJson ? JSON.parse(String(task.outputJson)) : null, outputJson: undefined })), dependencies, messages: messageViews, events, participants };
}

export function listRuns(userId: string) {
  return getDb().prepare(`SELECT id, project_id AS projectId, title, mode, status, created_at AS createdAt,
    updated_at AS updatedAt, completed_at AS completedAt FROM task_runs WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`).all(userId);
}

export function cancelRun(userId: string, runId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const changed = db.prepare(`UPDATE task_runs SET status='cancel_requested', cancel_requested_at=?, updated_at=?
      WHERE id=? AND user_id=? AND status NOT IN ('succeeded','failed','cancelled')`).run(now, now, runId, userId);
    if (!changed.changes) return false;
    db.prepare(`UPDATE tasks SET status='cancelled', updated_at=?, completed_at=?
      WHERE run_id=? AND status IN ('blocked','ready','retry_wait','waiting')`).run(now, now, runId);
    db.prepare(`UPDATE tasks SET status='cancel_requested', updated_at=? WHERE run_id=? AND status IN ('leased','running')`).run(now, runId);
    db.prepare(`UPDATE agent_messages SET state='expired',updated_at=? WHERE run_id=? AND state='pending'`).run(now, runId);
    addEvent(db, runId, null, "RunCancelRequested", {});
    return true;
  })();
  return result;
}
