import { z } from "zod";
import { assertSafeJsonSchema } from "@/src/modules/gateway/schema-validation";
import type { JsonSchema } from "@/src/modules/gateway/types";

export const READ_ONLY_BROKER_TOOL_NAMES = ["web_fetch", "github_repository_read", "artifact_text_read"] as const;
export const INTERNAL_ORCHESTRATION_TOOL_NAMES = ["agent_message_send", "delegate_task"] as const;
export const BROKER_TOOL_NAMES = [...READ_ONLY_BROKER_TOOL_NAMES, ...INTERNAL_ORCHESTRATION_TOOL_NAMES] as const;
export type ReadOnlyBrokerToolName = (typeof READ_ONLY_BROKER_TOOL_NAMES)[number];
export type InternalOrchestrationToolName = (typeof INTERNAL_ORCHESTRATION_TOOL_NAMES)[number];
export type BrokerToolName = (typeof BROKER_TOOL_NAMES)[number];
export const MAX_AGENT_TURNS = 12;
export const MAX_AGENT_TOOL_CALLS = 12;
export const MAX_AGENT_MESSAGES_PER_ATTEMPT = 8;
export const MAX_AGENT_DELEGATIONS_PER_ATTEMPT = 4;

export const permissionPolicySchema = z.object({
  mode: z.enum(["read_only", "read_only_or_internal"]).default("read_only"),
  maxToolCalls: z.number().int().min(0).max(MAX_AGENT_TOOL_CALLS).default(4),
  maxMessages: z.number().int().min(0).max(MAX_AGENT_MESSAGES_PER_ATTEMPT).default(0),
  maxDelegations: z.number().int().min(0).max(MAX_AGENT_DELEGATIONS_PER_ATTEMPT).default(0),
}).strict();

export function normalizeAllowedTools(value: string[]): BrokerToolName[] {
  const unique = [...new Set(value)];
  for (const tool of unique) if (!(BROKER_TOOL_NAMES as readonly string[]).includes(tool)) throw new Error(`Unsupported tool: ${tool}`);
  return unique as BrokerToolName[];
}

export function validateOutputSchema(value: unknown): JsonSchema | null {
  if (value == null) return null;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Output schema must be a JSON object.");
  const schema = value as JsonSchema;
  assertSafeJsonSchema(schema);
  if (schema.type !== "object") throw new Error("Output schema root type must be object.");
  return schema;
}
