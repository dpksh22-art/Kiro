import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { deleteMemory, updateMemory } from "@/src/modules/workspace/memory";

const updateSchema = z.object({
  kind: z.enum(["instruction", "decision"]),
  content: z.string().trim().min(1).max(4000),
  retentionPolicy: z.enum(["permanent", "30_days", "90_days"]),
}).strict();

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid memory update.", issues: parsed.error.issues }, { status: 400 });
  const { id } = await context.params;
  return updateMemory(session.user.id, id, parsed.data)
    ? Response.json({ updated: true })
    : Response.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  return deleteMemory(session.user.id, id)
    ? Response.json({ deleted: true })
    : Response.json({ error: "Not found" }, { status: 404 });
}
