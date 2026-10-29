import { randomUUID } from "node:crypto";
import { getDb } from "@/src/core/database";
import { writeAudit } from "@/src/core/audit";
import { getAdapter } from "@/src/modules/gateway/adapters";
import { releaseUsage, reserveUsage, settleUsage } from "@/src/modules/gateway/budgets";
import { connectionCredentials, getConnection } from "@/src/modules/gateway/connections";

export type ChatTarget = { connectionId: string; modelId: string };
export type ChatInput = {
  userId: string;
  projectId: string;
  conversationId?: string;
  prompt: string;
  mode: "single" | "parallel";
  targets: ChatTarget[];
  requestSignal?: AbortSignal;
};

type TargetRecord = ChatTarget & { provider: string; connectionLabel: string; displayName: string; inputPrice: number | null; outputPrice: number | null; pricingCurrency: string | null };

function targetForUser(userId: string, target: ChatTarget): TargetRecord {
  const row = getDb().prepare(`SELECT c.provider, c.label AS connectionLabel, m.display_name AS displayName,
    m.input_price_micros_per_million AS inputPrice, m.output_price_micros_per_million AS outputPrice, m.pricing_currency AS pricingCurrency
    FROM models m JOIN provider_connections c ON c.id=m.connection_id
    WHERE c.user_id=? AND c.id=? AND m.provider_model_id=? AND m.availability='available'`)
    .get(userId, target.connectionId, target.modelId) as Omit<TargetRecord, keyof ChatTarget> | undefined;
  if (!row) throw new Error(`Model ${target.modelId} is not available on this connection.`);
  return { ...target, ...row };
}

function estimateCost(target: TargetRecord, prompt: string, maxOutputTokens: number): number | undefined {
  if (target.inputPrice === null || target.outputPrice === null) return undefined;
  const estimatedInputTokens = Math.ceil(prompt.length / 4);
  return Math.ceil((estimatedInputTokens * target.inputPrice + maxOutputTokens * target.outputPrice) / 1_000_000);
}

export function streamChat(input: ChatInput): ReadableStream<Uint8Array> {
  const db = getDb();
  const project = db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").get(input.projectId, input.userId);
  if (!project) throw new Error("Project not found.");
  const targets = input.targets.map((target) => targetForUser(input.userId, target));
  const now = new Date().toISOString();
  const conversationId = input.conversationId ?? randomUUID();
  const userMessageId = randomUUID();
  const answerIds = targets.map(() => randomUUID());
  const reservationIds: string[] = [];
  const maxOutputTokens = 2048;
  db.transaction(() => {
    if (input.conversationId) {
      const found = db.prepare("SELECT id FROM conversations WHERE id=? AND user_id=? AND project_id=?").get(input.conversationId, input.userId, input.projectId);
      if (!found) throw new Error("Conversation not found.");
    } else {
      db.prepare(`INSERT INTO conversations (id, project_id, user_id, title, mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conversationId, input.projectId, input.userId, input.prompt.trim().slice(0, 80) || "New conversation", input.mode, now, now);
    }
    db.prepare(`INSERT INTO messages (id, conversation_id, role, status, content, created_at, completed_at)
      VALUES (?, ?, 'user', 'completed', ?, ?, ?)`).run(userMessageId, conversationId, input.prompt, now, now);
    targets.forEach((target, index) => {
      const estimated = estimateCost(target, input.prompt, maxOutputTokens);
      db.prepare(`INSERT INTO messages
        (id, conversation_id, parent_message_id, role, connection_id, provider_model_id, status, content, estimated_cost_micros, created_at)
        VALUES (?, ?, ?, 'assistant', ?, ?, 'queued', '', ?, ?)`)
        .run(answerIds[index], conversationId, userMessageId, target.connectionId, target.modelId, estimated ?? null, now);
      reservationIds[index] = reserveUsage({ userId: input.userId, projectId: input.projectId, messageId: answerIds[index], provider: target.provider, modelId: target.modelId, estimatedCostMicros: estimated, currency: target.pricingCurrency ?? undefined });
    });
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
  })();

  const encoder = new TextEncoder();
  let closed = false;
  const abortController = new AbortController();
  input.requestSignal?.addEventListener("abort", () => abortController.abort(), { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("chat.created", { conversationId, userMessageId, answers: targets.map((target, index) => ({ answerId: answerIds[index], provider: target.provider, modelId: target.modelId, displayName: target.displayName })) });

      const runTarget = async (target: TargetRecord, index: number) => {
        const answerId = answerIds[index]!;
        const connection = getConnection(input.userId, target.connectionId);
        if (!connection) throw new Error("Provider connection disappeared.");
        let content = "";
        let finalUsage: { inputTokens?: number; outputTokens?: number; billedCostMicros?: number; currency?: string } | undefined;
        try {
          db.prepare("UPDATE messages SET status='streaming' WHERE id=?").run(answerId);
          send("answer.started", { answerId });
          for await (const event of getAdapter(target.provider).stream({ modelId: target.modelId, messages: [{ role: "user", content: input.prompt }], maxOutputTokens, signal: abortController.signal }, connectionCredentials(connection))) {
            if (event.type === "content.delta") {
              content += event.text;
              send("answer.delta", { answerId, text: event.text });
            } else if (event.type === "usage.updated" || event.type === "response.completed") {
              if (event.usage) finalUsage = { ...finalUsage, ...event.usage };
            }
          }
          const completedAt = new Date().toISOString();
          db.prepare(`UPDATE messages SET status='completed', content=?, input_tokens=?, output_tokens=?, billed_cost_micros=?, completed_at=? WHERE id=?`)
            .run(content, finalUsage?.inputTokens ?? null, finalUsage?.outputTokens ?? null, finalUsage?.billedCostMicros ?? null, completedAt, answerId);
          settleUsage(reservationIds[index]!, finalUsage ?? {});
          send("answer.completed", { answerId, usage: finalUsage });
        } catch (error) {
          const cancelled = abortController.signal.aborted;
          const message = cancelled ? "Cancelled." : error instanceof Error ? error.message : "Model request failed.";
          db.prepare("UPDATE messages SET status=?, content=?, error_code=?, error_message=?, completed_at=? WHERE id=?")
            .run(cancelled ? "cancelled" : "failed", content, cancelled ? "cancelled" : "provider_error", message.slice(0, 500), new Date().toISOString(), answerId);
          releaseUsage(reservationIds[index]!);
          send(cancelled ? "answer.cancelled" : "answer.failed", { answerId, message });
        }
      };

      Promise.allSettled(targets.map(runTarget)).then(() => {
        writeAudit({ userId: input.userId, action: "chat.completed", resourceType: "conversation", resourceId: conversationId, outcome: abortController.signal.aborted ? "failure" : "success", metadata: { mode: input.mode, targetCount: targets.length } });
        send("chat.completed", { conversationId });
        closed = true;
        controller.close();
      });
    },
    cancel() {
      closed = true;
      abortController.abort();
    },
  });
}
