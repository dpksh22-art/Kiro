import { GatewayError, providerError } from "@/src/modules/gateway/errors";
import { completedToolCall, contentParts, openAIToolChoice, parseStructuredOutput, validateRequestCapabilities, type PendingToolCall } from "@/src/modules/gateway/mapping";
import { openAIStrictWireSchema, normalizeOpenAIOptionalValue, normalizeOpenAIOptionalValues } from "@/src/modules/gateway/provider-schemas";
import { JSON_SCHEMA_LIMITS } from "@/src/modules/gateway/schema-validation";
import { appendBoundedUtf8, parseSse, PROVIDER_STREAM_LIMITS } from "@/src/modules/gateway/streaming";
import type { GatewayEvent, GatewayMessage, GenerateRequest, ProviderAdapter, ProviderCredentials, ProviderModel, Usage } from "@/src/modules/gateway/types";

type Profile = { provider: string; defaultBaseUrl: string; requireKey: boolean; headers?: Record<string, string> };
const url = (base: string, path: string) => `${base.replace(/\/$/, "")}${path}`;

function usageFrom(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return { inputTokens: typeof item.prompt_tokens === "number" ? item.prompt_tokens : undefined, outputTokens: typeof item.completion_tokens === "number" ? item.completion_tokens : undefined };
}

function messagesForOpenAI(messages: GatewayMessage[]): unknown[] {
  const output: unknown[] = [];
  for (const message of messages) {
    const parts = contentParts(message.content);
    const results = parts.filter((part) => part.type === "tool_result");
    if (message.role === "tool" || results.length) {
      for (const part of results) output.push({ role: "tool", tool_call_id: part.type === "tool_result" ? part.callId : "", content: part.type === "tool_result" ? part.content : "" });
      continue;
    }
    const calls: unknown[] = [];
    const mappedContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    for (const part of parts) {
      if (part.type === "tool_call") calls.push({ id: part.call.id, type: "function", function: { name: part.call.name, arguments: JSON.stringify(part.call.arguments) } });
      else if (part.type === "text") mappedContent.push({ type: "text", text: part.text });
      else if (part.type === "image_url") mappedContent.push({ type: "image_url", image_url: { url: part.url } });
    }
    const textOnly = mappedContent.every((part) => part.type === "text");
    const content: unknown = textOnly ? mappedContent.map((part) => part.text ?? "").join("") : mappedContent;
    output.push({ role: message.role, content: content || (calls.length ? null : ""), ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return output;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly provider: string;
  constructor(private readonly profile: Profile) { this.provider = profile.provider; }

  private headers(credentials: ProviderCredentials): HeadersInit {
    if (this.profile.requireKey && !credentials.apiKey) throw new GatewayError("authentication_failed", "An API key is required.", 401);
    return { Accept: "application/json", "Content-Type": "application/json", ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}), ...this.profile.headers };
  }
  private base(credentials: ProviderCredentials): string { return credentials.baseUrl || this.profile.defaultBaseUrl; }

  async listModels(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    const response = await fetch(url(this.base(credentials), "/v1/models"), { headers: this.headers(credentials), signal });
    if (!response.ok) throw await providerError(response);
    const body = await response.json() as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.data)) throw new GatewayError("provider_error", "Provider returned an invalid model list.");
    return body.data.flatMap((item) => typeof item.id === "string" ? [{ id: item.id, displayName: typeof item.name === "string" ? item.name : item.id, capabilities: { text: "conditional", streaming: "conditional", tools: "conditional", structured_output: "conditional" } as const, metadata: { ownedBy: item.owned_by } }] : []);
  }

  async *stream(request: GenerateRequest, credentials: ProviderCredentials): AsyncGenerator<GatewayEvent> {
    validateRequestCapabilities(request, { tools: true, structured: "json_schema_and_object", imageUrl: true });
    const responseFormat = request.responseFormat?.type === "json_schema"
      ? { type: "json_schema", json_schema: { name: request.responseFormat.name, schema: openAIStrictWireSchema(request.responseFormat.schema), strict: true } }
      : request.responseFormat?.type === "json_object" ? { type: "json_object" } : undefined;
    const canonicalTools = new Map((request.tools ?? []).map((tool) => [tool.name, tool.inputSchema]));
    let response: Response;
    const requestHeaders = this.headers(credentials);
    try {
      request.onDispatch?.();
      response = await fetch(url(this.base(credentials), "/v1/chat/completions"), {
        method: "POST", headers: requestHeaders, signal: request.signal,
        body: JSON.stringify({ model: request.modelId, messages: messagesForOpenAI(request.messages), stream: true, stream_options: { include_usage: true },
          ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: openAIStrictWireSchema(tool.inputSchema), strict: true } })), tool_choice: openAIToolChoice(request.toolChoice) ?? "auto" } : {}),
          ...(responseFormat ? { response_format: responseFormat } : {}), ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw new GatewayError("provider_unavailable", error instanceof Error ? error.message : "Provider request failed.", 503, true);
    }
    if (!response.ok) throw await providerError(response);
    const requestId = response.headers.get("x-request-id") ?? undefined;
    yield { type: "response.started", providerRequestId: requestId };
    let finalUsage: Usage | undefined;
    let finishReason: string | undefined;
    let sawTerminal = false;
    let structuredText = "";
    const pending = new Map<number, PendingToolCall>();
    try {
      for await (const item of parseSse(response)) {
        if (item.data === "[DONE]") { sawTerminal = true; break; }
        const chunk = JSON.parse(item.data) as Record<string, unknown>;
        if (chunk.error) {
          const providerMessage = (chunk.error as Record<string, unknown>).message;
          throw new GatewayError("provider_error", typeof providerMessage === "string" ? providerMessage : "Provider stream failed.");
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
        if (typeof choices[0]?.finish_reason === "string") finishReason = choices[0].finish_reason;
        const delta = choices[0]?.delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string" && delta.content) { structuredText = appendBoundedUtf8(structuredText, delta.content, JSON_SCHEMA_LIMITS.maxOutputBytes, "structured output"); yield { type: "content.delta", text: delta.content }; }
        const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
        for (const raw of toolCalls) {
          const index = typeof raw.index === "number" ? raw.index : 0;
          const fn = raw.function as Record<string, unknown> | undefined;
          const current = pending.get(index) ?? { id: "", name: "", argumentsText: "" };
          if (typeof raw.id === "string") current.id = raw.id;
          if (typeof fn?.name === "string") current.name += fn.name;
          if (typeof fn?.arguments === "string") current.argumentsText = appendBoundedUtf8(current.argumentsText, fn.arguments, PROVIDER_STREAM_LIMITS.maxToolArgumentsBytes, "tool arguments");
          pending.set(index, current);
          yield { type: "tool_call.delta", index, callId: typeof raw.id === "string" ? raw.id : undefined, name: typeof fn?.name === "string" ? fn.name : undefined, argumentsDelta: typeof fn?.arguments === "string" ? fn.arguments : undefined };
        }
        const parsedUsage = usageFrom(chunk.usage);
        if (parsedUsage) { finalUsage = parsedUsage; yield { type: "usage.updated", usage: parsedUsage }; }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw error instanceof SyntaxError ? new GatewayError("provider_error", "Provider returned malformed stream JSON.", 502) : error;
    }
    if (!sawTerminal) throw new GatewayError("provider_error", "Provider stream ended without a terminal marker.", 502, true);
    yield { type: "response.completed", finishReason, usage: finalUsage, providerRequestId: requestId };
    for (const [index, value] of [...pending].sort(([left], [right]) => left - right)) {
      if (!value.id || !value.name) throw new GatewayError("provider_error", "Provider returned an incomplete tool call.", 502);
      const call = completedToolCall(value);
      const canonicalSchema = canonicalTools.get(call.name);
      yield { type: "tool_call.completed", index, call: canonicalSchema ? { ...call, arguments: normalizeOpenAIOptionalValues(call.arguments, canonicalSchema) } : call };
    }
    if (request.responseFormat && request.responseFormat.type !== "text" && pending.size === 0) {
      const canonicalSchema = request.responseFormat.type === "json_schema" ? request.responseFormat.schema : undefined;
      yield { type: "structured_output.completed", value: parseStructuredOutput(structuredText, canonicalSchema, canonicalSchema ? (value) => normalizeOpenAIOptionalValue(value, canonicalSchema) : undefined) };
    }
  }
}
