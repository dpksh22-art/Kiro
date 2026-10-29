import { requireApiSession } from "@/src/core/session";
import { getDb } from "@/src/core/database";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const run = getDb().prepare("SELECT id FROM task_runs WHERE id=? AND user_id=?").get(id, session.user.id);
  if (!run) return Response.json({ error: "Not found" }, { status: 404 });
  const cursor = Number(new URL(request.url).searchParams.get("cursor") ?? request.headers.get("last-event-id") ?? 0);
  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  const close = (controller?: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    if (controller) try { controller.close(); } catch {}
  };
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let last = Number.isFinite(cursor) ? cursor : 0;
      let ticks = 0;
      const poll = () => {
        if (closed) return;
        const events = getDb().prepare(`SELECT sequence, id, task_id AS taskId, event_type AS eventType, actor_type AS actorType,
          payload_json AS payloadJson, created_at AS createdAt FROM task_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 100`).all(id, last) as Array<Record<string, unknown>>;
        for (const event of events) {
          last = Number(event.sequence);
          const data = { ...event, payload: JSON.parse(String(event.payloadJson)), payloadJson: undefined };
          controller.enqueue(encoder.encode(`id: ${last}\nevent: ${event.eventType}\ndata: ${JSON.stringify(data)}\n\n`));
        }
        ticks += 1;
        if (ticks >= 50) close(controller);
      };
      poll();
      if (!closed) interval = setInterval(poll, 500);
      request.signal.addEventListener("abort", () => close(controller), { once: true });
    },
    cancel() { close(); },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
