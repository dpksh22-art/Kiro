import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { connectGitHub, githubStatus } from "@/src/modules/github/service";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ connections: githubStatus(session.user.id).map((item) => ({ ...item, permissions: JSON.parse(String(item.permissionsJson)), permissionsJson: undefined })) });
}

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = z.object({ token: z.string().min(20).max(1_000) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid token." }, { status: 400 });
  try { return Response.json(await connectGitHub(session.user.id, parsed.data.token), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub connection failed." }, { status: 502 }); }
}
