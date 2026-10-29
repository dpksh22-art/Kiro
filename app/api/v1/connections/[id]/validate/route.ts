import { requireApiSession } from "@/src/core/session";
import { validateConnection } from "@/src/modules/gateway/connections";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const modelCount = await validateConnection(session.user.id, id);
    return Response.json({ status: "connected", modelCount });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Connection validation failed." }, { status: 502 });
  }
}
