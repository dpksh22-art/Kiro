import { requireApiSession } from "@/src/core/session";
import { disconnectProvider } from "@/src/modules/lifecycle/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const result = disconnectProvider(session.user.id, id);
  return result ? Response.json(result) : Response.json({ error: "Not found" }, { status: 404 });
}
