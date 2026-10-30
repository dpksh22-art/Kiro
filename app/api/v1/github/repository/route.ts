import { requireApiSession } from "@/src/core/session";
import { repositoryOverview } from "@/src/modules/github/service";

export async function GET(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const repo = new URL(request.url).searchParams.get("repo");
  if (!repo) return Response.json({ error: "Missing repo." }, { status: 400 });
  try { return Response.json(await repositoryOverview(session.user.id, repo, request.signal)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "GitHub request failed." }, { status: 502 }); }
}
