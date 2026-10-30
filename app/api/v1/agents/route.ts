import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createAgent, listAgents } from "@/src/modules/agents/service";
import { BROKER_TOOL_NAMES, MAX_AGENT_DELEGATIONS_PER_ATTEMPT, MAX_AGENT_MESSAGES_PER_ATTEMPT, MAX_AGENT_TOOL_CALLS, MAX_AGENT_TURNS } from "@/src/modules/agents/policy";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ agents: listAgents(session.user.id).map((agent) => ({
    ...agent,
    allowedTools: JSON.parse(String(agent.allowedToolsJson)),
    permissionPolicy: JSON.parse(String(agent.permissionPolicyJson)),
    budget: JSON.parse(String(agent.budgetJson)),
    outputSchema: agent.outputSchemaJson ? JSON.parse(String(agent.outputSchemaJson)) : null,
    allowedToolsJson: undefined, permissionPolicyJson: undefined, budgetJson: undefined, outputSchemaJson: undefined,
  })) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({
    name: z.string().trim().min(1).max(100), role: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(20_000), allowedTools: z.array(z.enum(BROKER_TOOL_NAMES)).max(BROKER_TOOL_NAMES.length).default([]),
    permissionPolicy: z.object({
      mode: z.enum(["read_only", "read_only_or_internal"]).default("read_only"),
      maxToolCalls: z.number().int().min(0).max(MAX_AGENT_TOOL_CALLS).default(4),
      maxMessages: z.number().int().min(0).max(MAX_AGENT_MESSAGES_PER_ATTEMPT).default(0),
      maxDelegations: z.number().int().min(0).max(MAX_AGENT_DELEGATIONS_PER_ATTEMPT).default(0),
    }).strict().default({ mode: "read_only", maxToolCalls: 4, maxMessages: 0, maxDelegations: 0 }),
    budget: z.object({ perRun: z.object({
      modelCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      toolCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    }).strict().default({}) }).strict().default({ perRun: {} }),
    maxDurationSeconds: z.number().int().min(10).max(86_400).default(600), maxTurns: z.number().int().min(1).max(MAX_AGENT_TURNS).default(8),
    outputSchema: z.record(z.string(), z.unknown()).nullable().default(null), completionCriteria: z.string().max(2_000).optional(),
  }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid agent", issues: parsed.error.issues }, { status: 400 });
  try { return Response.json({ id: createAgent(session.user.id, parsed.data) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid agent" }, { status: 400 }); }
}
