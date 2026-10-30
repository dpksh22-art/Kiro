import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createPullRequest, GitHubServiceError } from "@/src/modules/github/service";

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ repo: z.string(), title: z.string().trim().min(1).max(256), body: z.string().max(65_000), head: z.string(), base: z.string(), idempotencyKey: z.uuid(), confirm: z.literal(true) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid or unconfirmed draft pull-request request.", issues: parsed.error.issues }, { status: 400 });
  const { repo, ...input } = parsed.data;
  try { return Response.json(await createPullRequest(session.user.id, repo, input, request.signal), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub write failed." }, { status: error instanceof GitHubServiceError ? error.status : 502 }); }
}
