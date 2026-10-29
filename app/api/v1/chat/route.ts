import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { streamChat } from "@/src/modules/workspace/chat";

const schema = z.object({
  projectId: z.uuid(),
  conversationId: z.uuid().optional(),
  prompt: z.string().trim().min(1).max(100_000),
  mode: z.enum(["single", "parallel"]),
  targets: z.array(z.object({ connectionId: z.uuid(), modelId: z.string().min(1).max(300) })).min(1).max(4),
}).superRefine((value, ctx) => {
  if (value.mode === "single" && value.targets.length !== 1) ctx.addIssue({ code: "custom", message: "Single mode requires one model.", path: ["targets"] });
  if (value.mode === "parallel" && value.targets.length < 2) ctx.addIssue({ code: "custom", message: "Parallel mode requires at least two models.", path: ["targets"] });
});

export async function POST(request: Request) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  try {
    const stream = streamChat({ ...parsed.data, userId: session.user.id, requestSignal: request.signal });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to start chat." }, { status: 400 });
  }
}
