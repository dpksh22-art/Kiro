import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicAdapter } from "@/src/modules/gateway/adapters/anthropic";
import { GatewayError } from "@/src/modules/gateway/errors";

const adapter = new AnthropicAdapter();
const request = { modelId: "claude-test", messages: [{ role: "user" as const, content: "Hello" }] };

async function collect(stream: ReturnType<AnthropicAdapter["stream"]>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function rejection(stream: ReturnType<AnthropicAdapter["stream"]>) {
  try {
    await collect(stream);
    throw new Error("Expected stream to reject.");
  } catch (error) {
    return error;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Anthropic adapter contract", () => {
  it("discovers models and authenticates without inventing pricing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: "claude-test", display_name: "Claude Test", created_at: "2026-01-01T00:00:00Z" },
      { display_name: "ignored" },
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await adapter.listModels({ apiKey: "anthropic-key" });

    expect(models).toEqual([{
      id: "claude-test",
      displayName: "Claude Test",
      capabilities: { text: "supported", streaming: "supported", tools: "supported", structured_output: "conditional" },
      metadata: { createdAt: "2026-01-01T00:00:00Z" },
    }]);
    expect(models[0]?.metadata).not.toHaveProperty("pricing");
    expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ "x-api-key": "anthropic-key", "anthropic-version": "2023-06-01" }),
    }));
  });

  it("streams text and usage through the required terminal marker", async () => {
    const stream = [
      'event: message_start\ndata: {"message":{"id":"msg-1","usage":{"input_tokens":4}}}\n\n',
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "request-id": "req-header" } })));

    const events = await collect(adapter.stream(request, { apiKey: "anthropic-key" }));

    expect(events).toContainEqual({ type: "content.delta", text: "Hi" });
    expect(events).toContainEqual({ type: "usage.updated", usage: { inputTokens: 4, outputTokens: 2 } });
    expect(events.at(-1)).toEqual({
      type: "response.completed",
      finishReason: "end_turn",
      usage: { inputTokens: 4, outputTokens: 2 },
      providerRequestId: "msg-1",
    });
  });

  it("rejects in-band errors and truncated streams", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('event: error\ndata: {"type":"error","error":{"message":"anthropic failed"}}\n\n', { status: 200 })));
    await expect(collect(adapter.stream(request, { apiKey: "anthropic-key" }))).rejects.toThrow("anthropic failed");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"partial"}}\n\n', { status: 200 })));
    const error = await rejection(adapter.stream(request, { apiKey: "anthropic-key" }));
    expect(error).toMatchObject({ code: "provider_error", retryable: true });
    expect(error).toBeInstanceOf(GatewayError);
  });

  it("preserves missing-key authentication failures", async () => {
    const error = await rejection(adapter.stream(request, {}));
    expect(error).toMatchObject({ code: "authentication_failed", status: 401, retryable: false });
  });

  it("normalizes cancellation after response headers", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller.signal.addEventListener("abort", () => streamController.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const iterator = adapter.stream({ ...request, signal: controller.signal }, { apiKey: "anthropic-key" });

    expect(await iterator.next()).toEqual({ value: { type: "response.started", providerRequestId: undefined }, done: false });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled", status: 499 });
  });
});


describe("Anthropic bounded discovery pagination", () => {
  it("returns a complete two-page snapshot and rejects a repeated cursor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "one" }], has_more: true, last_id: "cursor-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "two" }], has_more: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter.listModels({ apiKey: "key" })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "one" }), expect.objectContaining({ id: "two" })]));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("after_id=cursor-1");

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], has_more: true, last_id: "same" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], has_more: true, last_id: "same" }), { status: 200 })));
    await expect(adapter.listModels({ apiKey: "key" })).rejects.toThrow(/invalid cursor/i);
  });
});
