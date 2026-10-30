import { z } from "zod";
import { requireApiSession } from "@/src/core/session";
import { writeAudit } from "@/src/core/audit";
import { listAgentMessages, replyAgentMessage, sendAgentMessage } from "@/src/modules/agents/collaboration";
import { workerTick } from "@/src/modules/agents/runtime";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const messages = listAgentMessages(session.user.id, id);
  return messages ? Response.json({ messages }) : Response.json({ error: "Not found" }, { status: 404 });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireApiSession(request);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const parsed = z.object({
    recipientAgentId: z.uuid(),
    body: z.string().trim().min(1).max(8_000),
    correlationId: z.string().max(200).optional(),
    replyToId: z.uuid().optional(),
    idempotencyKey: z.string().min(1).max(200),
    ttlSeconds: z.number().int().min(1).max(86_400).optional(),
  }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message", issues: parsed.error.issues }, { status: 400 });
  try {
    const messageInput = { userId: session.user.id, runId: id, ...parsed.data };
    const result = parsed.data.replyToId ? replyAgentMessage({ ...messageInput, replyToId: parsed.data.replyToId }) : sendAgentMessage(messageInput);
    void workerTick();
    return Response.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message.";
    writeAudit({ userId: session.user.id, action: "agent.message.human_sent", resourceType: "task_run", resourceId: id, outcome: "denied", metadata: { reason: message } });
    return Response.json({ error: message }, { status: /not found/i.test(message) ? 404 : 400 });
  }
}
