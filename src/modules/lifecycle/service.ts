import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";

export type DisconnectResult = { disconnected: boolean; credentialDeleted: boolean; revokedRemotely: false };

export function disconnectProvider(userId: string, id: string): DisconnectResult | null {
  const db = getDb();
  const connection = db.prepare("SELECT id FROM provider_connections WHERE id=? AND user_id=?").get(id, userId);
  if (!connection) return null;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE provider_connections SET encrypted_credential=NULL,status='disconnected',last_error=NULL,
      validation_generation=validation_generation+1,updated_at=? WHERE id=? AND user_id=?`).run(now, id, userId);
    db.prepare("UPDATE models SET availability='unavailable',updated_at=? WHERE connection_id=?").run(now, id);
    writeAudit({ userId, action: "provider.connection.disconnected", resourceType: "provider_connection", resourceId: id, outcome: "success", metadata: { credentialDeleted: true, revokedRemotely: false } });
  })();
  return { disconnected: true, credentialDeleted: true, revokedRemotely: false };
}

export function disconnectGitHub(userId: string, id: string): DisconnectResult | null {
  const db = getDb();
  const connection = db.prepare("SELECT id FROM github_connections WHERE id=? AND user_id=?").get(id, userId);
  if (!connection) return null;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE github_connections SET encrypted_token=NULL,status='disconnected',updated_at=? WHERE id=? AND user_id=?`).run(now, id, userId);
    writeAudit({ userId, action: "github.disconnected", resourceType: "github_connection", resourceId: id, outcome: "success", metadata: { credentialDeleted: true, revokedRemotely: false } });
  })();
  return { disconnected: true, credentialDeleted: true, revokedRemotely: false };
}

export function deleteProject(userId: string, id: string): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM projects WHERE id=? AND user_id=?").get(id, userId)) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM projects WHERE id=? AND user_id=?").run(id, userId);
    writeAudit({ userId, action: "project.deleted", resourceType: "project", resourceId: id, outcome: "success" });
  })();
  return true;
}

export function deleteConversation(userId: string, id: string): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM conversations WHERE id=? AND user_id=?").get(id, userId)) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM conversations WHERE id=? AND user_id=?").run(id, userId);
    writeAudit({ userId, action: "conversation.deleted", resourceType: "conversation", resourceId: id, outcome: "success" });
  })();
  return true;
}
