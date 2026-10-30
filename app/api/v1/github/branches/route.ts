import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createBranch, GitHubServiceError, readBranch } from "@/src/modules/github/service";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const parsed = z.object({ repo: z.string().min(3).max(200), branch: z.string().min(1).max(200) }).safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return Response.json({ error: "Repository and explicit branch are required.", issues: parsed.error.issues }, { status: 400 });
  try { return Response.json(await readBranch(session.user.id, parsed.data.repo, parsed.data.branch, request.signal)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub branch read failed." }, { status: error instanceof GitHubServiceError ? error.status : 502 }); }
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ repo: z.string(), branch: z.string(), base: z.string(), idempotencyKey: z.uuid(), confirm: z.literal(true) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid or unconfirmed branch request.", issues: parsed.error.issues }, { status: 400 });
  const { repo, ...input } = parsed.data;
  try { return Response.json(await createBranch(session.user.id, repo, input, request.signal), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub write failed." }, { status: error instanceof GitHubServiceError ? error.status : 502 }); }
}
