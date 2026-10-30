import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { ArtifactError, listArtifacts, uploadArtifact } from "@/src/modules/artifacts/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ artifacts: listArtifacts(session.user.id) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request, { allowedMutationContentTypes: [
    "application/octet-stream", "text/plain", "text/markdown", "application/pdf",
    "image/png", "image/jpeg", "image/gif", "image/webp",
  ] });
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const rawFilename = request.headers.get("x-nexus-filename");
  let filename: string | undefined;
  try { filename = rawFilename ? decodeURIComponent(rawFilename) : undefined; } catch { filename = undefined; }
  const parsed = z.object({
    filename: z.string().min(1).max(600),
    projectId: z.string().uuid().optional(),
    contentLength: z.coerce.number().int().nonnegative().optional(),
  }).safeParse({
    filename,
    projectId: request.headers.get("x-nexus-project-id") || undefined,
    contentLength: request.headers.get("content-length") || undefined,
  });
  if (!parsed.success || !request.body) return Response.json({ error: "A file body and valid X-Nexus-Filename header are required." }, { status: 400 });
  try {
    const artifact = await uploadArtifact({
      userId: session.user.id,
      stream: request.body,
      filename: parsed.data.filename,
      declaredMediaType: request.headers.get("content-type") ?? undefined,
      contentLength: parsed.data.contentLength,
      projectId: parsed.data.projectId,
    });
    return Response.json({ artifact }, { status: 201 });
  } catch (error) {
    const status = error instanceof ArtifactError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Artifact upload failed." }, { status });
  }
}
