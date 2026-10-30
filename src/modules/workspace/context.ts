import { getDb } from "@/src/core/database";
import type { GatewayMessage } from "@/src/modules/gateway/types";

export const MEMORY_CONTEXT_CHARACTER_LIMIT = 12_000;
export const CHAT_HISTORY_CHARACTER_LIMIT = 24_000;
export const CHAT_HISTORY_MESSAGE_LIMIT = 24;

export function trustedProjectMemoryContext(userId: string, projectId: string, limit = MEMORY_CONTEXT_CHARACTER_LIMIT): string {
  const rows = getDb().prepare(`SELECT kind,content,provenance,updated_at AS updatedAt FROM project_memories
    WHERE user_id=? AND project_id=? AND trust_level='trusted_user' AND provenance='explicit_user'
      AND (expires_at IS NULL OR expires_at>?)
    ORDER BY CASE kind WHEN 'instruction' THEN 0 ELSE 1 END, updated_at DESC, id
    LIMIT 100`).all(userId, projectId, new Date().toISOString()) as Array<{ kind: string; content: string; provenance: string; updatedAt: string }>;
  if (!rows.length) return "";
  const header = "Trusted project memory (explicit owner-authored context; provenance: explicit_user):\n";
  let output = header;
  for (const row of rows) {
    const entry = `[${row.kind}; ${row.provenance}; updated ${row.updatedAt}]\n${row.content.trim()}\n`;
    if (output.length + entry.length > limit) break;
    output += entry;
  }
  return output === header ? "" : output.trim();
}

export function boundedConversationHistory(userId: string, projectId: string, conversationId?: string): GatewayMessage[] {
  if (!conversationId) return [];
  const owner = getDb().prepare("SELECT 1 FROM conversations WHERE id=? AND user_id=? AND project_id=?").get(conversationId, userId, projectId);
  if (!owner) throw new Error("Conversation not found.");
  const rows = getDb().prepare(`SELECT role,content,connection_id AS connectionId,provider_model_id AS modelId
    FROM messages WHERE conversation_id=? AND status='completed' AND role IN ('user','assistant')
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(conversationId, CHAT_HISTORY_MESSAGE_LIMIT) as Array<{ role: "user" | "assistant"; content: string; connectionId: string | null; modelId: string | null }>;
  const selected: GatewayMessage[] = [];
  let characters = 0;
  for (const row of rows) {
    const label = row.role === "assistant" && row.modelId ? `[Prior assistant response from model ${row.modelId}]\n` : "";
    const content = `${label}${row.content}`;
    if (characters + content.length > CHAT_HISTORY_CHARACTER_LIMIT) break;
    selected.push({ role: row.role, content });
    characters += content.length;
  }
  return selected.reverse();
}
