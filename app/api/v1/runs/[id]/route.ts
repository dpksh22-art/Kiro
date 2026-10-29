import { requireApiSession } from "@/src/core/session";
import { getRun } from "@/src/modules/agents/service";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const run = getRun(session.user.id, id);
  return run ? Response.json({ run }) : Response.json({ error: "Not found" }, { status: 404 });
}
