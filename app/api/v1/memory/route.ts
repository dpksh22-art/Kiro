import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createMemory, listMemories } from "@/src/modules/workspace/memory";

const createSchema = z.object({
  projectId: z.string().uuid(),
  kind: z.enum(["instruction", "decision"]),
  content: z.string().trim().min(1).max(4000),
  retentionPolicy: z.enum(["permanent", "30_days", "90_days"]),
}).strict();

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const projectId = new URL(request.url).searchParams.get("projectId") ?? undefined;
  if (projectId && !z.string().uuid().safeParse(projectId).success) return Response.json({ error: "Invalid project." }, { status: 400 });
  return Response.json({ memories: listMemories(session.user.id, projectId) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Only explicit user-created instructions and decisions can be stored.", issues: parsed.error.issues }, { status: 400 });
  try { return Response.json({ id: createMemory(session.user.id, parsed.data) }, { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to save memory." }, { status: 404 }); }
}
