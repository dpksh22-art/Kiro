import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/src/core/database";
import { getTestUser } from "@/tests/helpers";
import { createProject } from "@/src/modules/workspace/service";
import { createMemory } from "@/src/modules/workspace/memory";
import { boundedConversationHistory, CHAT_HISTORY_CHARACTER_LIMIT, CHAT_HISTORY_MESSAGE_LIMIT } from "@/src/modules/workspace/context";
import { createConnection } from "@/src/modules/gateway/connections";
import { streamChat } from "@/src/modules/workspace/chat";

async function consume(stream: ReadableStream<Uint8Array>) { const reader = stream.getReader(); let text = ""; while (true) { const { done, value } = await reader.read(); if (done) return text; text += new TextDecoder().decode(value); } }

describe("trusted memory and bounded chat replay", () => {
  it("injects only active explicit memory and replays bounded completed history", async () => {
    const db = getDb(); const userId = getTestUser(); const projectId = createProject(userId, `Context ${randomUUID()}`); const now = new Date().toISOString();
    createMemory(userId, { projectId, kind: "instruction", content: "TRUSTED_PROJECT_RULE", retentionPolicy: "permanent" });
    const expiredId = createMemory(userId, { projectId, kind: "decision", content: "EXPIRED_RULE", retentionPolicy: "30_days" });
    db.prepare("UPDATE project_memories SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), expiredId);
    db.prepare(`INSERT INTO research_sources (id,user_id,connector,source_type,title,canonical_url,retrieved_at,content_hash,excerpt,metadata_json,trust_level)
      VALUES (?,?, 'web','page','bad','https://example.com/bad',?,'hash','MALICIOUS_RESEARCH','{}','untrusted_external')`).run(randomUUID(), userId, now);
    const conversationId = randomUUID();
    db.prepare("INSERT INTO conversations (id,project_id,user_id,title,mode,created_at,updated_at) VALUES (?,?,?,'history','single',?,?)").run(conversationId, projectId, userId, now, now);
    db.prepare("INSERT INTO messages (id,conversation_id,role,status,content,created_at,completed_at) VALUES (?,?,'user','completed','OLD_USER_MESSAGE',?,?)").run(randomUUID(), conversationId, now, now);
    db.prepare("INSERT INTO messages (id,conversation_id,role,status,content,created_at,completed_at) VALUES (?,?,'assistant','completed','OLD_ASSISTANT_MESSAGE',?,?)").run(randomUUID(), conversationId, now, now);
    const connectionId = createConnection(userId, { provider: "openai", label: `Context ${randomUUID()}`, apiKey: "key" }); const modelId = `context-${randomUUID()}`;
    db.prepare(`INSERT INTO models (id,connection_id,provider_model_id,display_name,capabilities_json,availability,created_at,updated_at) VALUES (?,?,?,?,?,'available',?,?)`).run(randomUUID(), connectionId, modelId, "Context Model", '{"text":"supported"}', now, now);
    db.prepare("UPDATE provider_connections SET status='connected' WHERE id=?").run(connectionId);
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { body = JSON.parse(String(init.body)) as Record<string, unknown>; return new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 }); }));
    await consume(streamChat({ userId, projectId, conversationId, prompt: "FOLLOW_UP", mode: "single", targets: [{ connectionId, modelId }] }));
    const encoded = JSON.stringify(body);
    expect(encoded).toContain("TRUSTED_PROJECT_RULE");
    expect(encoded).toContain("provenance: explicit_user");
    expect(encoded).not.toContain("EXPIRED_RULE");
    expect(encoded).not.toContain("MALICIOUS_RESEARCH");
    expect(encoded).toContain("OLD_USER_MESSAGE");
    expect(encoded).toContain("OLD_ASSISTANT_MESSAGE");
    expect(encoded.indexOf("OLD_USER_MESSAGE")).toBeLessThan(encoded.indexOf("FOLLOW_UP"));
    for (let index = 0; index < 30; index += 1) db.prepare("INSERT INTO messages (id,conversation_id,role,status,content,created_at,completed_at) VALUES (?,?,'user','completed',?,?,?)").run(randomUUID(), conversationId, `${index}:${"x".repeat(1_500)}`, new Date(Date.now() + index + 1).toISOString(), now);
    const history = boundedConversationHistory(userId, projectId, conversationId);
    expect(history.length).toBeLessThanOrEqual(CHAT_HISTORY_MESSAGE_LIMIT);
    expect(history.reduce((sum, message) => sum + (typeof message.content === "string" ? message.content.length : 0), 0)).toBeLessThanOrEqual(CHAT_HISTORY_CHARACTER_LIMIT);
    vi.unstubAllGlobals();
  });
});
