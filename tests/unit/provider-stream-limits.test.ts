import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAdapter } from "@/src/modules/gateway/adapters/openai-compatible";
import { AnthropicAdapter } from "@/src/modules/gateway/adapters/anthropic";
import { GeminiAdapter } from "@/src/modules/gateway/adapters/gemini";
import { parseSse, PROVIDER_STREAM_LIMITS } from "@/src/modules/gateway/streaming";

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> { const output: T[] = []; for await (const value of stream) output.push(value); return output; }
afterEach(() => vi.unstubAllGlobals());

describe("provider stream pre-allocation limits", () => {
  it("cancels the reader when one chunked SSE frame exceeds its byte bound", async () => {
    let cancelled = false;
    const payload = `data: ${"x".repeat(PROVIDER_STREAM_LIMITS.maxFrameBytes + 1)}\n\n`;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoded = new TextEncoder().encode(payload);
        for (let offset = 0; offset < encoded.length; offset += 4_096) controller.enqueue(encoded.slice(offset, offset + 4_096));
      },
      cancel() { cancelled = true; },
    }));
    await expect(collect(parseSse(response))).rejects.toThrow(/byte limit/i);
    expect(cancelled).toBe(true);
  });

  it("rejects many valid frames before concatenating oversized structured output", async () => {
    const first = "a".repeat(600_000);
    const second = "b".repeat(600_000);
    const stream = [first, second].map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join("") + "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    const adapter = new OpenAICompatibleAdapter({ provider: "test", defaultBaseUrl: "https://models.example", requireKey: true });
    await expect(collect(adapter.stream({ modelId: "m", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_object" } }, { apiKey: "key" }))).rejects.toThrow(/structured output.*byte limit/i);
  });
});


describe("native adapter aggregate limits", () => {
  it("bounds Anthropic and Gemini generated text before concatenation", async () => {
    const first = "a".repeat(600_000); const second = "b".repeat(600_000);
    const anthropicStream = [first, second].map((text) => `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "text_delta", text } })}\n\n`).join("") + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(anthropicStream, { status: 200 })));
    await expect(collect(new AnthropicAdapter().stream({ modelId: "a", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_schema", name: "x", strict: true, schema: { type: "object" } } }, { apiKey: "key" }))).rejects.toThrow(/structured output.*byte limit/i);

    const geminiStream = [first, second].map((text) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`).join("") + 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(geminiStream, { status: 200 })));
    await expect(collect(new GeminiAdapter().stream({ modelId: "g", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_object" } }, { apiKey: "key" }))).rejects.toThrow(/structured output.*byte limit/i);
  });
});


describe("Gemini merged tool argument limit", () => {
  it("rejects repeated same-call fragments whose merged arguments exceed the per-call ceiling", async () => {
    const left = "a".repeat(140_000); const right = "b".repeat(140_000);
    const stream = [
      { candidates: [{ content: { parts: [{ functionCall: { id: "same", name: "tool", args: { left } } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { id: "same", name: "tool", args: { right } } }] }, finishReason: "STOP" }] },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    await expect(collect(new GeminiAdapter().stream({ modelId: "g", messages: [{ role: "user", content: "call" }], tools: [{ name: "tool", description: "fixture", inputSchema: { type: "object" } }] }, { apiKey: "key" }))).rejects.toThrow(/tool arguments.*byte limit/i);
  });
});
