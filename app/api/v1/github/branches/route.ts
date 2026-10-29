import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { createBranch } from "@/src/modules/github/service";

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ repo: z.string(), branch: z.string(), base: z.string(), confirm: z.literal(true) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid or unconfirmed branch request.", issues: parsed.error.issues }, { status: 400 });
  const { repo, ...input } = parsed.data;
  try { return Response.json(await createBranch(session.user.id, repo, input), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub write failed." }, { status: 502 }); }
}
