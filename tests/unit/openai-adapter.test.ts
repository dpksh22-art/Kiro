import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAdapter } from "@/src/modules/gateway/adapters/openai-compatible";

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible adapter", () => {
  const adapter = new OpenAICompatibleAdapter({ provider: "test", defaultBaseUrl: "https://models.example", requireKey: true });
  it("normalizes model discovery without inventing pricing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-a", owned_by: "vendor" }] }), { status: 200 })));
    const models = await adapter.listModels({ apiKey: "key" });
    expect(models[0]).toMatchObject({ id: "model-a", displayName: "model-a", capabilities: { tools: "conditional" } });
    expect(models[0]?.metadata).not.toHaveProperty("pricing");
  });
  it("normalizes streamed deltas and usage", async () => {
    const stream = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "x-request-id": "req-1" } })));
    const events = [];
    for await (const event of adapter.stream({ modelId: "model-a", messages: [{ role: "user", content: "Hello" }] }, { apiKey: "key" })) events.push(event);
    expect(events).toContainEqual({ type: "content.delta", text: "Hi" });
    expect(events).toContainEqual({ type: "usage.updated", usage: { inputTokens: 3, outputTokens: 1 } });
    expect(events.at(-1)).toMatchObject({ type: "response.completed", providerRequestId: "req-1" });
  });
  it("rejects in-band errors and truncated streams", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"error":{"message":"upstream failed"}}\n\n', { status: 200 })));
    const consume = async () => { for await (const event of adapter.stream({ modelId: "model-a", messages: [{ role: "user", content: "Hello" }] }, { apiKey: "key" })) void event; };
    await expect(consume()).rejects.toThrow("upstream failed");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { status: 200 })));
    await expect(consume()).rejects.toThrow(/terminal marker/i);
  });
});
