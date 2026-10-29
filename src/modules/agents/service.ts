import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { AGENT_TEMPLATES } from "@/src/modules/agents/templates";
import type { ChatTarget } from "@/src/modules/workspace/chat";

export type CreateAgentInput = {
  name: string;
  role: string;
  instructions: string;
  allowedTools?: string[];
  maxDurationSeconds?: number;
  maxTurns?: number;
  completionCriteria?: string;
};

export function ensureTemplates(userId: string): void {
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO agents
    (id, user_id, slug, name, role, instructions, allowed_tools_json, max_duration_seconds, max_turns, completion_criteria, is_template, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 8, ?, 1, ?, ?)`);
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const template of AGENT_TEMPLATES) insert.run(randomUUID(), userId, template.slug, template.name, template.role, template.instructions, JSON.stringify(template.tools), 600, template.completionCriteria, now, now);
  })();
}

export function listAgents(userId: string) {
  ensureTemplates(userId);
  return getDb().prepare(`SELECT id, slug, name, role, instructions, allowed_tools_json AS allowedToolsJson,
    permission_policy_json AS permissionPolicyJson, budget_json AS budgetJson, max_duration_seconds AS maxDurationSeconds,
    max_turns AS maxTurns, memory_scope AS memoryScope, completion_criteria AS completionCriteria, is_template AS isTemplate,
    created_at AS createdAt, updated_at AS updatedAt FROM agents WHERE user_id=? ORDER BY is_template DESC, name`).all(userId) as Array<Record<string, unknown>>;
}

export function createAgent(userId: string, input: CreateAgentInput): string {
  const id = randomUUID();
  const slug = `custom-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50)}-${id.slice(0, 6)}`;
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO agents
    (id, user_id, slug, name, role, instructions, allowed_tools_json, max_duration_seconds, max_turns, completion_criteria, is_template, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(id, userId, slug, input.name, input.role, input.instructions, JSON.stringify(input.allowedTools ?? []), input.maxDurationSeconds ?? 600, input.maxTurns ?? 8, input.completionCriteria ?? "", now, now);
  writeAudit({ userId, action: "agent.created", resourceType: "agent", resourceId: id, outcome: "success" });
  return id;
}

export function createAgentRun(input: {
  userId: string; projectId: string; goal: string; mode: "team" | "review" | "research" | "engineering";
  agentIds: string[]; targets: ChatTarget[]; maxParallelism?: number; deadlineSeconds?: number;
}): string {
  ensureTemplates(input.userId);
  const db = getDb();
  const project = db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").get(input.projectId, input.userId);
  if (!project) throw new Error("Project not found.");
  const agents = input.agentIds.map((id) => db.prepare("SELECT id, name, role, instructions, completion_criteria AS completionCriteria FROM agents WHERE id=? AND user_id=?").get(id, input.userId) as { id: string; name: string; role: string; instructions: string; completionCriteria: string } | undefined);
  if (agents.some((agent) => !agent)) throw new Error("One or more agents were not found.");
  for (const target of input.targets) {
    const found = db.prepare(`SELECT 1 FROM models m JOIN provider_connections c ON c.id=m.connection_id
      WHERE c.user_id=? AND c.id=? AND m.provider_model_id=? AND m.availability='available'`).get(input.userId, target.connectionId, target.modelId);
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
          JSON.stringify({ goal: input.goal, instructions: agent!.instructions, completionCriteria: agent!.completionCriteria, target }), now, now);
      addEvent(db, runId, taskId, "TaskCreated", { title: agent!.name, status: "ready" });
    });
    const synthesisId = randomUUID();
    db.prepare(`INSERT INTO tasks
      (id, run_id, task_key, title, description, task_type, status, depth, priority, input_json, created_at, updated_at)
      VALUES (?, ?, 'synthesis', 'Synthesis and verification', 'Reconcile independent outputs, disagreements, and evidence.', 'synthesis', 'blocked', 1, 90, ?, ?, ?)`)
      .run(synthesisId, runId, JSON.stringify({ goal: input.goal, target: input.targets[0], mode: input.mode }), now, now);
    const dependency = db.prepare("INSERT INTO task_dependencies (task_id, depends_on_task_id, predicate, required) VALUES (?, ?, 'terminal', 1)");
    taskIds.forEach((taskId) => dependency.run(synthesisId, taskId));
    addEvent(db, runId, synthesisId, "TaskCreated", { title: "Synthesis and verification", status: "blocked", dependencies: taskIds });
    addEvent(db, runId, null, "RunStarted", { mode: input.mode, taskCount: taskIds.length + 1 });
  })();
  writeAudit({ userId: input.userId, action: "agent.run.created", resourceType: "task_run", resourceId: runId, outcome: "success", metadata: { mode: input.mode, agentCount: agents.length } });
  return runId;
}

export function addEvent(db: ReturnType<typeof getDb>, runId: string, taskId: string | null, eventType: string, payload: Record<string, unknown>): void {
  db.prepare(`INSERT INTO task_events (id, run_id, task_id, event_type, actor_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, 'orchestrator', ?, ?)`).run(randomUUID(), runId, taskId, eventType, JSON.stringify(payload), new Date().toISOString());
}

type RunRecord = {
  id: string; projectId: string | null; title: string; goal: string; mode: string; status: string;
  maxParallelism: number; deadlineAt: string | null; cancelRequestedAt: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
};

type TaskRecord = {
  id: string; parentTaskId: string | null; assignedAgentId: string | null; agentName: string | null;
  taskKey: string; title: string; description: string; taskType: string; status: string; depth: number;
  priority: number; attemptCount: number; maxAttempts: number; outputJson: string | null;
  errorCode: string | null; errorMessage: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
};

export function getRun(userId: string, runId: string) {
  const db = getDb();
  const run = db.prepare(`SELECT id, project_id AS projectId, title, goal, mode, status, max_parallelism AS maxParallelism,
    deadline_at AS deadlineAt, cancel_requested_at AS cancelRequestedAt, created_at AS createdAt,
    updated_at AS updatedAt, completed_at AS completedAt FROM task_runs WHERE id=? AND user_id=?`).get(runId, userId) as RunRecord | undefined;
  if (!run) return null;
  const tasks = db.prepare(`SELECT t.id, t.parent_task_id AS parentTaskId, t.assigned_agent_id AS assignedAgentId, a.name AS agentName,
    t.task_key AS taskKey, t.title, t.description, t.task_type AS taskType, t.status, t.depth, t.priority,
    t.attempt_count AS attemptCount, t.max_attempts AS maxAttempts, t.output_json AS outputJson,
    t.error_code AS errorCode, t.error_message AS errorMessage, t.created_at AS createdAt, t.updated_at AS updatedAt,
    t.completed_at AS completedAt FROM tasks t LEFT JOIN agents a ON a.id=t.assigned_agent_id WHERE t.run_id=? ORDER BY t.depth, t.priority DESC, t.created_at`).all(runId) as TaskRecord[];
  const dependencies = db.prepare(`SELECT d.task_id AS taskId, d.depends_on_task_id AS dependsOnTaskId, d.predicate, d.required
    FROM task_dependencies d JOIN tasks t ON t.id=d.task_id WHERE t.run_id=?`).all(runId);
  return { ...run, tasks: tasks.map((task) => ({ ...task, output: task.outputJson ? JSON.parse(String(task.outputJson)) : null, outputJson: undefined })), dependencies };
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
    addEvent(db, runId, null, "RunCancelRequested", {});
    return true;
  })();
  return result;
}
