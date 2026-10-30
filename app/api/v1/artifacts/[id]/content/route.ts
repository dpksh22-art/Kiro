import { requireApiSession } from "@/src/core/session";
import { ArtifactError, artifactDownload } from "@/src/modules/artifacts/service";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const download = await artifactDownload(session.user.id, id);
    if (!download) return Response.json({ error: "Not found" }, { status: 404 });
    const asciiName = download.record.name.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/["\\]/g, "_") || "artifact";
    return new Response(download.stream, { headers: {
      "Content-Type": download.record.mediaType,
      "Content-Length": String(download.record.byteSize),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(download.record.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Digest": `sha-256=${Buffer.from(download.record.contentHash, "hex").toString("base64")}`,
    } });
  } catch (error) {
    const status = error instanceof ArtifactError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "Artifact download failed." }, { status });
  }
}
