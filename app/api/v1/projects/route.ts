import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createProject, listProjects } from "@/src/modules/workspace/service";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ projects: listProjects(session.user.id) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid project", issues: parsed.error.issues }, { status: 400 });
  return Response.json({ id: createProject(session.user.id, parsed.data.name, parsed.data.description) }, { status: 201 });
}
