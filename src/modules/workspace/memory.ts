import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";

export type MemoryKind = "instruction" | "decision";
export type MemoryRetention = "permanent" | "30_days" | "90_days";
export type MemoryRecord = {
  id: string;
  projectId: string;
  projectName: string;
  kind: MemoryKind;
  content: string;
  trustLevel: "trusted_user";
  provenance: "explicit_user";
  retentionPolicy: MemoryRetention;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function expiry(retention: MemoryRetention, now: Date): string | null {
  if (retention === "permanent") return null;
  const days = retention === "30_days" ? 30 : 90;
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

function assertOwnedProject(userId: string, projectId: string): void {
  const row = getDb().prepare("SELECT 1 FROM projects WHERE id=? AND user_id=?").get(projectId, userId);
  if (!row) throw new Error("Project not found.");
}

export function purgeExpiredMemories(userId: string): number {
  const db = getDb();
  const now = new Date().toISOString();
  const expired = db.prepare("SELECT id FROM project_memories WHERE user_id=? AND expires_at IS NOT NULL AND expires_at<=?").all(userId, now) as Array<{ id: string }>;
  if (!expired.length) return 0;
  db.transaction(() => {
    db.prepare("DELETE FROM project_memories WHERE user_id=? AND expires_at IS NOT NULL AND expires_at<=?").run(userId, now);
    for (const memory of expired) writeAudit({ userId, action: "memory.expired", resourceType: "project_memory", resourceId: memory.id, outcome: "success" });
  })();
  return expired.length;
}

export function listMemories(userId: string, projectId?: string): MemoryRecord[] {
  purgeExpiredMemories(userId);
  const projectFilter = projectId ? "AND pm.project_id=?" : "";
  const parameters = projectId ? [userId, projectId] : [userId];
  return getDb().prepare(`SELECT pm.id, pm.project_id AS projectId, p.name AS projectName, pm.kind, pm.content,
    pm.trust_level AS trustLevel, pm.provenance, pm.retention_policy AS retentionPolicy,
    pm.expires_at AS expiresAt, pm.created_at AS createdAt, pm.updated_at AS updatedAt
    FROM project_memories pm JOIN projects p ON p.id=pm.project_id
    WHERE pm.user_id=? ${projectFilter} AND (pm.expires_at IS NULL OR pm.expires_at>?)
    ORDER BY pm.updated_at DESC`).all(...parameters, new Date().toISOString()) as MemoryRecord[];
}

export function createMemory(userId: string, input: { projectId: string; kind: MemoryKind; content: string; retentionPolicy: MemoryRetention }): string {
  assertOwnedProject(userId, input.projectId);
  const id = randomUUID();
  const now = new Date();
  const db = getDb();
  db.transaction(() => {
    db.prepare(`INSERT INTO project_memories
      (id,user_id,project_id,kind,content,trust_level,provenance,retention_policy,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'trusted_user','explicit_user',?,?,?,?)`).run(
        id, userId, input.projectId, input.kind, input.content, input.retentionPolicy,
        expiry(input.retentionPolicy, now), now.toISOString(), now.toISOString(),
      );
    writeAudit({ userId, action: "memory.created", resourceType: "project_memory", resourceId: id, outcome: "success", metadata: { projectId: input.projectId, kind: input.kind, retentionPolicy: input.retentionPolicy } });
  })();
  return id;
}

export function updateMemory(userId: string, id: string, input: { kind: MemoryKind; content: string; retentionPolicy: MemoryRetention }): boolean {
  const now = new Date();
  const row = getDb().prepare("SELECT project_id AS projectId FROM project_memories WHERE id=? AND user_id=?").get(id, userId) as { projectId: string } | undefined;
  if (!row) return false;
  const db = getDb();
  db.transaction(() => {
    db.prepare(`UPDATE project_memories SET kind=?,content=?,retention_policy=?,expires_at=?,updated_at=?
      WHERE id=? AND user_id=?`).run(input.kind, input.content, input.retentionPolicy, expiry(input.retentionPolicy, now), now.toISOString(), id, userId);
    writeAudit({ userId, action: "memory.updated", resourceType: "project_memory", resourceId: id, outcome: "success", metadata: { projectId: row.projectId, kind: input.kind, retentionPolicy: input.retentionPolicy } });
  })();
  return true;
}

export function deleteMemory(userId: string, id: string): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM project_memories WHERE id=? AND user_id=?").get(id, userId)) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM project_memories WHERE id=? AND user_id=?").run(id, userId);
    writeAudit({ userId, action: "memory.deleted", resourceType: "project_memory", resourceId: id, outcome: "success" });
  })();
  return true;
}
