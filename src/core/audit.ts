import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";

export type AuditInput = {
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: "success" | "denied" | "failure";
  requestId?: string | null;
  metadata?: Record<string, unknown>;
};

const SECRET_KEY_PATTERN = /token|secret|password|api.?key|authorization/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redact(item)]));
  }
  return value;
}

export function writeAudit(input: AuditInput): void {
  getDb().prepare(`
    INSERT INTO audit_events (id, user_id, action, resource_type, resource_id, outcome, request_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), input.userId ?? null, input.action, input.resourceType, input.resourceId ?? null,
    input.outcome, input.requestId ?? null, JSON.stringify(redact(input.metadata ?? {})), new Date().toISOString(),
  );
}
