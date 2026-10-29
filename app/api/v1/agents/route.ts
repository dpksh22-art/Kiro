import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createAgent, listAgents } from "@/src/modules/agents/service";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ agents: listAgents(session.user.id).map((agent) => ({ ...agent, allowedTools: JSON.parse(String(agent.allowedToolsJson)), allowedToolsJson: undefined })) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({
    name: z.string().trim().min(1).max(100), role: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(20_000), allowedTools: z.array(z.string().max(100)).max(20).optional(),
    maxDurationSeconds: z.number().int().min(10).max(86_400).optional(), maxTurns: z.number().int().min(1).max(50).optional(),
    completionCriteria: z.string().max(2_000).optional(),
  }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid agent", issues: parsed.error.issues }, { status: 400 });
  return Response.json({ id: createAgent(session.user.id, parsed.data) }, { status: 201 });
}
