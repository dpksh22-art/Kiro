import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { GitHubServiceError, readTextFile } from "@/src/modules/github/service";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const parsed = z.object({ repo: z.string().min(3).max(200), ref: z.string().min(1).max(200), path: z.string().min(1).max(1024) }).safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return Response.json({ error: "Repository, explicit ref, and file path are required.", issues: parsed.error.issues }, { status: 400 });
  try { return Response.json(await readTextFile(session.user.id, parsed.data.repo, parsed.data.ref, parsed.data.path, request.signal)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub file read failed." }, { status: error instanceof GitHubServiceError ? error.status : 502 }); }
}
