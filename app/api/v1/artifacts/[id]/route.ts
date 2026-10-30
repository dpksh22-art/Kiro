import { requireApiSession } from "@/src/core/session";
import { ArtifactError, deleteArtifact, getArtifact } from "@/src/modules/artifacts/service";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const artifact = getArtifact(session.user.id, id);
  return artifact ? Response.json({ artifact }) : Response.json({ error: "Not found" }, { status: 404 });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    return await deleteArtifact(session.user.id, id)
      ? Response.json({ deleted: true })
      : Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const status = error instanceof ArtifactError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Artifact deletion failed." }, { status });
  }
}
