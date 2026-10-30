import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiAdapter } from "@/src/modules/gateway/adapters/gemini";
import { GatewayError } from "@/src/modules/gateway/errors";

const adapter = new GeminiAdapter();
const request = { modelId: "gemini-test", messages: [{ role: "user" as const, content: "Hello" }] };

async function collect(stream: ReturnType<GeminiAdapter["stream"]>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function rejection(stream: ReturnType<GeminiAdapter["stream"]>) {
  try {
    await collect(stream);
    throw new Error("Expected stream to reject.");
  } catch (error) {
    return error;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("Gemini adapter contract", () => {
  it("discovers models and authenticates without inventing pricing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [
      { name: "models/gemini-test", displayName: "Gemini Test", inputTokenLimit: 100, outputTokenLimit: 20, supportedGenerationMethods: ["generateContent"] },
      { displayName: "ignored" },
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const models = await adapter.listModels({ apiKey: "gemini-key" });

    expect(models).toEqual([{
      id: "gemini-test",
      displayName: "Gemini Test",
      capabilities: { text: "supported", streaming: "conditional", tools: "conditional", structured_output: "conditional" },
      metadata: { inputTokenLimit: 100, outputTokenLimit: 20, supportedGenerationMethods: ["generateContent"] },
    }]);
    expect(models[0]?.metadata).not.toHaveProperty("pricing");
    expect(fetchMock).toHaveBeenCalledWith("https://generativelanguage.googleapis.com/v1beta/models", expect.objectContaining({
      headers: { "x-goog-api-key": "gemini-key" },
    }));
  });

  it("streams text and usage through a finish-reason terminal marker", async () => {
    const stream = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
    ].join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));

    const events = await collect(adapter.stream(request, { apiKey: "gemini-key" }));

    expect(events).toContainEqual({ type: "content.delta", text: "Hi" });
    expect(events).toContainEqual({ type: "usage.updated", usage: { inputTokens: 4, outputTokens: 2 } });
    expect(events.at(-1)).toEqual({ type: "response.completed", finishReason: "STOP", usage: { inputTokens: 4, outputTokens: 2 } });
  });

  it("rejects in-band errors and truncated streams", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"error":{"code":500,"message":"gemini failed"}}\n\n', { status: 200 })));
    await expect(collect(adapter.stream(request, { apiKey: "gemini-key" }))).rejects.toThrow("gemini failed");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n', { status: 200 })));
    const error = await rejection(adapter.stream(request, { apiKey: "gemini-key" }));
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
    const iterator = adapter.stream({ ...request, signal: controller.signal }, { apiKey: "gemini-key" });

    expect(await iterator.next()).toEqual({ value: { type: "response.started" }, done: false });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled", status: 499 });
  });
});


describe("Gemini bounded discovery pagination", () => {
  it("returns a complete two-page snapshot and fails closed on a later page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "models/one" }], nextPageToken: "next" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "models/two" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(adapter.listModels({ apiKey: "key" })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "one" }), expect.objectContaining({ id: "two" })]));
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("pageToken=next");

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "models/one" }], nextPageToken: "next" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "failed" }), { status: 503 })));
    await expect(adapter.listModels({ apiKey: "key" })).rejects.toBeInstanceOf(GatewayError);
  });
});
