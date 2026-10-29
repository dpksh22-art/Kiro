import { requireApiSession } from "@/src/core/session";
import { getDb } from "@/src/core/database";
import { workerTick } from "@/src/modules/agents/runtime";
import { addEvent } from "@/src/modules/agents/service";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const now = new Date().toISOString();
  const changed = getDb().prepare(`UPDATE task_runs SET status='running', cancel_requested_at=NULL, updated_at=?
    WHERE id=? AND user_id=? AND status IN ('paused','waiting','failed')`).run(now, id, session.user.id);
  if (!changed.changes) return Response.json({ error: "Run is not resumable." }, { status: 409 });
  getDb().prepare(`UPDATE tasks SET status='ready', ready_at=?, updated_at=? WHERE run_id=? AND status='failed' AND attempt_count<max_attempts`).run(now, now, id);
  addEvent(getDb(), id, null, "RunResumed", {});
  void workerTick();
  return Response.json({ status: "running" }, { status: 202 });
}
