import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { GitHubServiceError, MAX_GITHUB_TEXT_BYTES, previewTextFileChange } from "@/src/modules/github/service";

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ repo: z.string().min(3).max(200), ref: z.string().min(1).max(200), path: z.string().min(1).max(1024), content: z.string().max(MAX_GITHUB_TEXT_BYTES) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid file-change preview request.", issues: parsed.error.issues }, { status: 400 });
  const { repo, ...input } = parsed.data;
  try { return Response.json(await previewTextFileChange(session.user.id, repo, input, request.signal)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub preview failed." }, { status: error instanceof GitHubServiceError ? error.status : 502 }); }
}
