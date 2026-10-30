import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleAdapter } from "@/src/modules/gateway/adapters/openai-compatible";
import { AnthropicAdapter } from "@/src/modules/gateway/adapters/anthropic";
import { GeminiAdapter } from "@/src/modules/gateway/adapters/gemini";
import type { GenerateRequest } from "@/src/modules/gateway/types";

const tool = { name: "artifact_text_read", description: "Read clean text", inputSchema: { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"], additionalProperties: false } };
async function collect(stream: AsyncGenerator<unknown>) { const values = []; for await (const value of stream) values.push(value); return values; }
afterEach(() => vi.unstubAllGlobals());

describe("provider tool and structured mappings", () => {
  it("maps OpenAI content/tools/schema and joins partial tool calls", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (bodies.length === 1) return new Response([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"artifact_text_","arguments":"{\\"artifactId\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"\\"11111111-1111-4111-8111-111111111111\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(""), { status: 200 });
      return new Response('data: {"choices":[{"delta":{"content":"{\\"answer\\":\\"ok\\"}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({ provider: "test", defaultBaseUrl: "https://models.example", requireKey: true });
    const request: GenerateRequest = { modelId: "m", tools: [tool], toolChoice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_url", url: "https://images.example/a.png" }] }] };
    const events = await collect(adapter.stream(request, { apiKey: "key" }));
    expect(events).toContainEqual({ type: "tool_call.completed", index: 0, call: { id: "call-1", name: "artifact_text_read", arguments: { artifactId: "11111111-1111-4111-8111-111111111111" } } });
    expect(bodies[0]).toMatchObject({ tools: [{ type: "function", function: { name: tool.name, strict: true } }], tool_choice: { type: "function", function: { name: tool.name } } });
    expect(JSON.stringify(bodies[0])).toContain("image_url");
    const structured = await collect(adapter.stream({ modelId: "m", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_schema", name: "answer", strict: true, schema: { type: "object" } } }, { apiKey: "key" }));
    expect(bodies[1]).toMatchObject({ response_format: { type: "json_schema", json_schema: { name: "answer", strict: true } } });
    expect(structured).toContainEqual({ type: "structured_output.completed", value: { answer: "ok" } });
  });

  it("maps Anthropic tool blocks/results and partial JSON", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response([
        'event: message_start\ndata: {"message":{"id":"msg-1","usage":{"input_tokens":2}}}\n\n',
        'event: content_block_start\ndata: {"index":0,"content_block":{"type":"tool_use","id":"call-a","name":"artifact_text_read","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"artifactId\\":\\"11111111-1111-4111-8111-111111111111\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"index":0}\n\n',
        'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""), { status: 200 });
    }));
    const events = await collect(new AnthropicAdapter().stream({ modelId: "claude", tools: [tool], toolChoice: "required", messages: [
      { role: "assistant", content: [{ type: "tool_call", call: { id: "old", name: tool.name, arguments: { artifactId: "x" } } }] },
      { role: "tool", content: [{ type: "tool_result", callId: "old", name: tool.name, content: "result" }] },
    ] }, { apiKey: "key" }));
    expect(events).toContainEqual({ type: "tool_call.completed", index: 0, call: { id: "call-a", name: tool.name, arguments: { artifactId: "11111111-1111-4111-8111-111111111111" } } });
    expect(body).toMatchObject({ tool_choice: { type: "any" }, tools: [{ name: tool.name }] });
    expect(JSON.stringify(body)).toContain("tool_result");
  });

  it("maps Gemini declarations, function history, output schema, and calls", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response([
        'data: {"candidates":[{"content":{"parts":[{"text":"{\\"answer\\":\\"ok\\"}"},{"functionCall":{"id":"g1","name":"artifact_text_read","args":{"artifactId":"11111111-1111-4111-8111-111111111111"}}}],"role":"model"}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"g1","name":"artifact_text_read","args":{}}}]},"finishReason":"STOP"}]}\n\n',
      ].join(""), { status: 200 });
    }));
    const events = await collect(new GeminiAdapter().stream({ modelId: "gemini", tools: [tool], toolChoice: "auto", responseFormat: { type: "json_schema", name: "answer", strict: true, schema: { type: "object" } }, messages: [
      { role: "assistant", content: [{ type: "tool_call", call: { id: "old", name: tool.name, arguments: { artifactId: "x" } } }] },
      { role: "tool", content: [{ type: "tool_result", callId: "old", name: tool.name, content: "{\"value\":1}" }] },
    ] }, { apiKey: "key" }));
    expect(events).toContainEqual({ type: "tool_call.completed", index: 0, call: { id: "g1", name: tool.name, arguments: { artifactId: "11111111-1111-4111-8111-111111111111" } } });
    expect(body).toMatchObject({ tools: [{ functionDeclarations: [{ name: tool.name }] }], generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } } });
    expect(JSON.stringify(body)).toContain("functionResponse");
  });

  it("rejects unresolved artifacts and unsupported capability shapes", async () => {
    const consume = (stream: AsyncGenerator<unknown>) => collect(stream);
    const gemini = new GeminiAdapter();
    await expect(consume(gemini.stream({ modelId: "g", messages: [{ role: "user", content: [{ type: "image_url", url: "https://images.example/a.png" }] }] }, { apiKey: "key" }))).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(consume(new AnthropicAdapter().stream({ modelId: "a", messages: [{ role: "user", content: "x" }], responseFormat: { type: "json_object" } }, { apiKey: "key" }))).rejects.toMatchObject({ code: "unsupported_capability" });
    const openai = new OpenAICompatibleAdapter({ provider: "test", defaultBaseUrl: "https://models.example", requireKey: true });
    await expect(consume(openai.stream({ modelId: "o", messages: [{ role: "user", content: [{ type: "artifact_reference", artifactId: "11111111-1111-4111-8111-111111111111" }] }] }, { apiKey: "key" }))).rejects.toMatchObject({ code: "request_invalid" });
  });
});


describe("documented provider wire-schema restrictions", () => {
  it("makes every OpenAI strict property required and represents local optional fields as nullable", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-optional","function":{"name":"optional_tool","arguments":"{\\"requiredValue\\":\\"yes\\",\\"optionalValue\\":null}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }));
    const optionalTool = { name: "optional_tool", description: "fixture", inputSchema: { type: "object", additionalProperties: false, properties: { requiredValue: { type: "string" }, optionalValue: { type: "string", maxLength: 10 } }, required: ["requiredValue"] } };
    const events = await collect(new OpenAICompatibleAdapter({ provider: "test", defaultBaseUrl: "https://models.example", requireKey: true }).stream({ modelId: "m", tools: [optionalTool], messages: [{ role: "user", content: "call" }] }, { apiKey: "key" }));
    const parameters = ((body.tools as Array<{ function: { parameters: Record<string, unknown> } }>)[0]!.function.parameters);
    expect(parameters.required).toEqual(["requiredValue", "optionalValue"]);
    expect((parameters.properties as Record<string, Record<string, unknown>>).optionalValue!.type).toEqual(["string", "null"]);
    expect(events).toContainEqual({ type: "tool_call.completed", index: 0, call: { id: "call-optional", name: "optional_tool", arguments: { requiredValue: "yes" } } });
  });

  it("removes Anthropic-unsupported assertion keywords while local schema validation remains exact", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('event: message_start\ndata: {"message":{"id":"m","usage":{"input_tokens":1}}}\n\nevent: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"{\\"answer\\":\\"ok\\"}"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200 });
    }));
    const schema = { type: "object", additionalProperties: false, properties: { answer: { type: "string", minLength: 1, maxLength: 20 } }, required: ["answer"] };
    await collect(new AnthropicAdapter().stream({ modelId: "claude", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_schema", name: "answer", strict: true, schema } }, { apiKey: "key" }));
    const wire = (((body.output_config as { format: { schema: Record<string, unknown> } }).format.schema.properties as Record<string, Record<string, unknown>>).answer);
    expect(wire).not.toHaveProperty("minLength");
    expect(wire).not.toHaveProperty("maxLength");
    expect(schema.properties.answer).toMatchObject({ minLength: 1, maxLength: 20 });
  });
});


describe("OpenAI strict structured optional normalization", () => {
  it("removes nested wire-only nulls while retaining explicitly nullable canonical values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"{\\"requiredValue\\":\\"yes\\",\\"optionalNested\\":{\\"requiredChild\\":\\"ok\\",\\"optionalChild\\":null},\\"explicitNullable\\":null}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 })));
    const schema = {
      type: "object", additionalProperties: false,
      properties: {
        requiredValue: { type: "string" },
        optionalNested: { type: "object", additionalProperties: false, properties: { requiredChild: { type: "string" }, optionalChild: { type: "string" } }, required: ["requiredChild"] },
        explicitNullable: { type: ["string", "null"] },
      },
      required: ["requiredValue"],
    };
    const events = await collect(new OpenAICompatibleAdapter({ provider: "test", defaultBaseUrl: "https://models.example", requireKey: true }).stream({ modelId: "m", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_schema", name: "optional", strict: true, schema } }, { apiKey: "key" }));
    expect(events).toContainEqual({ type: "structured_output.completed", value: { requiredValue: "yes", optionalNested: { requiredChild: "ok" }, explicitNullable: null } });
  });
});


describe("OpenAI strict subset rejection", () => {
  it("does not claim strict compatibility for open or composed object schemas", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const adapter = new OpenAICompatibleAdapter({ provider: "test", defaultBaseUrl: "https://models.example", requireKey: true });
    const consume = (schema: Record<string, unknown>) => collect(adapter.stream({ modelId: "m", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_schema", name: "unsupported", strict: true, schema } }, { apiKey: "key" }));
    await expect(consume({ type: "object", additionalProperties: true })).rejects.toMatchObject({ code: "unsupported_capability" });
    await expect(consume({ type: "object", additionalProperties: false, allOf: [{ type: "object", additionalProperties: false }] })).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
