import { requireApiSession } from "@/src/core/session";
import { cancelRun } from "@/src/modules/agents/service";
import { abortRun } from "@/src/modules/agents/runtime";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const changed = cancelRun(session.user.id, id);
  if (!changed) return Response.json({ error: "Run not found or already terminal." }, { status: 404 });
  abortRun(id);
  return Response.json({ status: "cancel_requested" }, { status: 202 });
}
