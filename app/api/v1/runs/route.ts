import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createAgentRun, listRuns } from "@/src/modules/agents/service";
import { workerTick } from "@/src/modules/agents/runtime";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ runs: listRuns(session.user.id) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({
    projectId: z.uuid(), goal: z.string().trim().min(1).max(100_000), mode: z.enum(["team", "review", "research", "engineering"]),
    agentIds: z.array(z.uuid()).min(1).max(8), targets: z.array(z.object({ connectionId: z.uuid(), modelId: z.string().min(1).max(300) })).min(1).max(4),
    maxParallelism: z.number().int().min(1).max(8).optional(), deadlineSeconds: z.number().int().min(60).max(86_400).optional(),
  }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid run", issues: parsed.error.issues }, { status: 400 });
  try {
    const runId = createAgentRun({ userId: session.user.id, ...parsed.data });
    void workerTick();
    return Response.json({ runId }, { status: 202 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to create run." }, { status: 400 });
  }
}
