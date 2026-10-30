import { requireApiSession } from "@/src/core/session";
import { deleteProject } from "@/src/modules/lifecycle/service";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  return deleteProject(session.user.id, id)
    ? Response.json({ deleted: true })
    : Response.json({ error: "Not found" }, { status: 404 });
}
