import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { applyTextFileChange, GitHubServiceError, MAX_GITHUB_TEXT_BYTES } from "@/src/modules/github/service";

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({
    repo: z.string().min(3).max(200),
    branch: z.string().min(1).max(200),
    path: z.string().min(1).max(1024),
    content: z.string().max(MAX_GITHUB_TEXT_BYTES),
    expectedSha: z.string().regex(/^[0-9a-f]{40}$/i).nullable(),
    message: z.string().trim().min(1).max(256),
    idempotencyKey: z.uuid(),
    confirm: z.literal(true),
  }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid or unconfirmed file-change request.", issues: parsed.error.issues }, { status: 400 });
  const { repo, ...input } = parsed.data;
  try { return Response.json(await applyTextFileChange(session.user.id, repo, input, request.signal), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub write failed." }, { status: error instanceof GitHubServiceError ? error.status : 502 }); }
}
