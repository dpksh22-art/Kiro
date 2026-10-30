import { requireApiSession } from "@/src/core/session";
import { listRepositories } from "@/src/modules/github/service";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try { return Response.json({ repositories: await listRepositories(session.user.id, request.signal) }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub request failed." }, { status: 502 }); }
}
