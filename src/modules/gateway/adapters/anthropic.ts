import { GatewayError, providerError } from "@/src/modules/gateway/errors";
import { anthropicToolChoice, completedToolCall, contentParts, parseStructuredOutput, textContent, validateRequestCapabilities, type PendingToolCall } from "@/src/modules/gateway/mapping";
import { anthropicWireSchema } from "@/src/modules/gateway/provider-schemas";
import { JSON_SCHEMA_LIMITS } from "@/src/modules/gateway/schema-validation";
import { appendBoundedUtf8, parseSse, PROVIDER_STREAM_LIMITS } from "@/src/modules/gateway/streaming";
import type { GatewayEvent, GatewayMessage, GenerateRequest, ProviderAdapter, ProviderCredentials, ProviderModel, Usage } from "@/src/modules/gateway/types";

const BASE_URL = "https://api.anthropic.com";

function messagesForAnthropic(messages: GatewayMessage[]): unknown[] {
  return messages.filter((message) => message.role !== "system").map((message) => {
    const mapped: unknown[] = [];
    for (const part of contentParts(message.content)) {
      if (part.type === "text") mapped.push({ type: "text", text: part.text });
      else if (part.type === "image_url") mapped.push({ type: "image", source: { type: "url", url: part.url } });
      else if (part.type === "tool_call") mapped.push({ type: "tool_use", id: part.call.id, name: part.call.name, input: part.call.arguments });
      else if (part.type === "tool_result") mapped.push({ type: "tool_result", tool_use_id: part.callId, content: part.content, is_error: Boolean(part.isError) });
    }
    return { role: message.role === "assistant" ? "assistant" : "user", content: mapped };
  });
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic";
  private headers(credentials: ProviderCredentials): HeadersInit {
    if (!credentials.apiKey) throw new GatewayError("authentication_failed", "An Anthropic API key is required.", 401);
    return { "content-type": "application/json", "x-api-key": credentials.apiKey, "anthropic-version": "2023-06-01" };
  }

  async listModels(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    const models: ProviderModel[] = [];
    let afterId: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const endpoint = new URL(`${BASE_URL}/v1/models`);
      if (afterId) endpoint.searchParams.set("after_id", afterId);
      const response = await fetch(endpoint.toString(), { headers: this.headers(credentials), signal });
      if (!response.ok) throw await providerError(response);
      const body = await response.json() as { data?: Array<Record<string, unknown>>; has_more?: unknown; last_id?: unknown };
      if (!Array.isArray(body.data)) throw new GatewayError("provider_error", "Anthropic returned an invalid model page.", 502);
      models.push(...body.data.flatMap((item) => typeof item.id === "string" ? [{ id: item.id, displayName: typeof item.display_name === "string" ? item.display_name : item.id, capabilities: { text: "supported", streaming: "supported", tools: "supported", structured_output: "conditional" } as const, metadata: { createdAt: item.created_at } }] : []));
      if (models.length > 10_000) throw new GatewayError("provider_error", "Anthropic model discovery exceeded the local model limit.", 502);
      if (body.has_more !== true) return models;
      if (typeof body.last_id !== "string" || !body.last_id || seenCursors.has(body.last_id)) throw new GatewayError("provider_error", "Anthropic model discovery returned an invalid cursor.", 502);
      seenCursors.add(body.last_id);
      afterId = body.last_id;
    }
    throw new GatewayError("provider_error", "Anthropic model discovery exceeded the local page limit.", 502);
  }

  async *stream(request: GenerateRequest, credentials: ProviderCredentials): AsyncGenerator<GatewayEvent> {
    validateRequestCapabilities(request, { tools: true, structured: "json_schema", imageUrl: true });
    if (request.toolChoice === "none" && request.tools?.length) throw new GatewayError("unsupported_capability", "Anthropic does not expose a none tool choice on this adapter; omit tools instead.", 400);
    const systemMessages = request.messages.filter((message) => message.role === "system");
    if (systemMessages.some((message) => contentParts(message.content).some((part) => part.type !== "text"))) throw new GatewayError("unsupported_capability", "Anthropic system content supports text only in this adapter.", 400);
    const system = systemMessages.map((message) => textContent(message.content)).join("\n\n");
    const outputConfig = request.responseFormat?.type === "json_schema" ? { format: { type: "json_schema", name: request.responseFormat.name, schema: anthropicWireSchema(request.responseFormat.schema) } } : undefined;
    let response: Response;
    const requestHeaders = this.headers(credentials);
    try {
      request.onDispatch?.();
      response = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST", headers: requestHeaders, signal: request.signal,
        body: JSON.stringify({ model: request.modelId, messages: messagesForAnthropic(request.messages), stream: true, max_tokens: request.maxOutputTokens ?? 2048,
          ...(system ? { system } : {}), ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: anthropicWireSchema(tool.inputSchema) })), tool_choice: anthropicToolChoice(request.toolChoice) } : {}),
          ...(outputConfig ? { output_config: outputConfig } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw new GatewayError("provider_unavailable", error instanceof Error ? error.message : "Provider request failed.", 503, true);
    }
    if (!response.ok) throw await providerError(response);
    let requestId = response.headers.get("request-id") ?? undefined;
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    let sawTerminal = false;
    let structuredText = "";
    let sawToolCall = false;
    const pending = new Map<number, PendingToolCall>();
    yield { type: "response.started", providerRequestId: requestId };
    try {
      for await (const item of parseSse(response)) {
        const chunk = JSON.parse(item.data) as Record<string, unknown>;
        if (item.event === "error" || chunk.type === "error") {
          const detail = chunk.error as Record<string, unknown> | undefined;
          throw new GatewayError("provider_error", typeof detail?.message === "string" ? detail.message : "Anthropic stream failed.");
        }
        if (item.event === "message_stop") sawTerminal = true;
        if (item.event === "message_start") {
          const message = chunk.message as Record<string, unknown> | undefined;
          if (typeof message?.id === "string") requestId = message.id;
          const raw = message?.usage as Record<string, unknown> | undefined;
          if (raw) usage = { inputTokens: typeof raw.input_tokens === "number" ? raw.input_tokens : undefined };
        }
        if (item.event === "content_block_start") {
          const index = typeof chunk.index === "number" ? chunk.index : 0;
          const block = chunk.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            const initialInput = block.input && !Array.isArray(block.input) && typeof block.input === "object" && Object.keys(block.input as Record<string, unknown>).length ? JSON.stringify(block.input) : "";
            if (Buffer.byteLength(initialInput, "utf8") > PROVIDER_STREAM_LIMITS.maxToolArgumentsBytes) throw new GatewayError("provider_error", "Provider tool arguments exceeded the local byte limit.", 502);
            sawToolCall = true;
            pending.set(index, { id: block.id, name: block.name, argumentsText: initialInput });
            yield { type: "tool_call.delta", index, callId: block.id, name: block.name };
          }
        }
        if (item.event === "content_block_delta") {
          const index = typeof chunk.index === "number" ? chunk.index : 0;
          const delta = chunk.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") { structuredText = appendBoundedUtf8(structuredText, delta.text, JSON_SCHEMA_LIMITS.maxOutputBytes, "structured output"); yield { type: "content.delta", text: delta.text }; }
          if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const current = pending.get(index);
            if (!current) throw new GatewayError("provider_error", "Anthropic streamed tool arguments before tool metadata.", 502);
            current.argumentsText = appendBoundedUtf8(current.argumentsText, delta.partial_json, PROVIDER_STREAM_LIMITS.maxToolArgumentsBytes, "tool arguments");
            yield { type: "tool_call.delta", index, argumentsDelta: delta.partial_json };
          }
        }
        if (item.event === "content_block_stop") {
          const index = typeof chunk.index === "number" ? chunk.index : 0;
          const current = pending.get(index);
          if (current) { yield { type: "tool_call.completed", index, call: completedToolCall(current) }; pending.delete(index); }
        }
        if (item.event === "message_delta") {
          const delta = chunk.delta as Record<string, unknown> | undefined;
          if (typeof delta?.stop_reason === "string") finishReason = delta.stop_reason;
          const raw = chunk.usage as Record<string, unknown> | undefined;
          if (raw) { usage = { ...usage, outputTokens: typeof raw.output_tokens === "number" ? raw.output_tokens : undefined }; yield { type: "usage.updated", usage }; }
        }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw error instanceof SyntaxError ? new GatewayError("provider_error", "Anthropic returned malformed stream JSON.", 502) : error;
    }
    if (!sawTerminal) throw new GatewayError("provider_error", "Anthropic stream ended without message_stop.", 502, true);
    yield { type: "response.completed", finishReason, usage, providerRequestId: requestId };
    if (pending.size) throw new GatewayError("provider_error", "Anthropic stream ended with an incomplete tool call.", 502);
    if (request.responseFormat?.type === "json_schema" && !sawToolCall) yield { type: "structured_output.completed", value: parseStructuredOutput(structuredText, request.responseFormat.schema) };
  }
}
