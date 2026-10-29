import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";

export type Project = { id: string; name: string; description: string; updatedAt: string };

export function listProjects(userId: string): Project[] {
  return getDb().prepare(`SELECT id, name, description, updated_at AS updatedAt
    FROM projects WHERE user_id=? ORDER BY updated_at DESC`).all(userId) as Project[];
}

export function createProject(userId: string, name: string, description = ""): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO projects (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, userId, name, description, now, now);
  return id;
}

export function ensureDefaultProject(userId: string): string {
  const existing = getDb().prepare("SELECT id FROM projects WHERE user_id=? ORDER BY created_at LIMIT 1").get(userId) as { id: string } | undefined;
  return existing?.id ?? createProject(userId, "Personal workspace", "Your private NEXUS workspace");
}

export function listConversations(userId: string, projectId?: string) {
  const where = projectId ? "AND project_id=?" : "";
  return getDb().prepare(`SELECT id, project_id AS projectId, title, mode, updated_at AS updatedAt
    FROM conversations WHERE user_id=? ${where} ORDER BY updated_at DESC LIMIT 100`).all(...(projectId ? [userId, projectId] : [userId])) as Array<Record<string, unknown>>;
}

export type ConversationDetail = {
  id: string;
  projectId: string;
  title: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
  messages: unknown[];
};

export function getConversation(userId: string, id: string): ConversationDetail | null {
  const conversation = getDb().prepare(`SELECT id, project_id AS projectId, title, mode, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id=? AND user_id=?`).get(id, userId) as Omit<ConversationDetail, "messages"> | undefined;
  if (!conversation) return null;
  const messages = getDb().prepare(`SELECT id, parent_message_id AS parentMessageId, role, connection_id AS connectionId,
    provider_model_id AS modelId, status, content, error_code AS errorCode, error_message AS errorMessage,
    input_tokens AS inputTokens, output_tokens AS outputTokens, estimated_cost_micros AS estimatedCostMicros,
    billed_cost_micros AS billedCostMicros, created_at AS createdAt, completed_at AS completedAt
    FROM messages WHERE conversation_id=? ORDER BY created_at, id`).all(id);
  return { ...conversation, messages };
}

export function dashboard(userId: string) {
  const db = getDb();
  const activeRuns = db.prepare("SELECT count(*) AS count FROM task_runs WHERE user_id=? AND status IN ('pending','running','waiting','paused','cancel_requested','cancelling')").get(userId) as { count: number };
  const blockedRuns = db.prepare("SELECT count(*) AS count FROM task_runs WHERE user_id=? AND status='failed'").get(userId) as { count: number };
  const connections = db.prepare("SELECT count(*) AS total, SUM(CASE WHEN status='connected' THEN 1 ELSE 0 END) AS connected FROM provider_connections WHERE user_id=?").get(userId) as { total: number; connected: number | null };
  const usage = db.prepare("SELECT COALESCE(SUM(COALESCE(billed_cost_micros, estimated_cost_micros)),0) AS micros FROM usage_records WHERE user_id=? AND created_at>=?").get(userId, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()) as { micros: number };
  return { activeRuns: activeRuns.count, failedRuns: blockedRuns.count, providers: { total: connections.total, connected: connections.connected ?? 0 }, monthCostMicros: usage.micros };
}
