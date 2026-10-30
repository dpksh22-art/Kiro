import { GatewayError, providerError } from "@/src/modules/gateway/errors";
import { contentParts, geminiToolConfig, parseStructuredOutput, textContent, validateRequestCapabilities } from "@/src/modules/gateway/mapping";
import { JSON_SCHEMA_LIMITS } from "@/src/modules/gateway/schema-validation";
import { appendBoundedUtf8, parseSse, PROVIDER_STREAM_LIMITS } from "@/src/modules/gateway/streaming";
import type { GatewayEvent, GatewayMessage, GenerateRequest, ProviderAdapter, ProviderCredentials, ProviderModel, Usage } from "@/src/modules/gateway/types";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function resultObject(content: string): Record<string, unknown> {
  try { const value = JSON.parse(content) as unknown; return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : { result: value }; }
  catch { return { result: content }; }
}

function messagesForGemini(messages: GatewayMessage[]): unknown[] {
  return messages.filter((message) => message.role !== "system").map((message) => {
    const mapped: unknown[] = [];
    for (const part of contentParts(message.content)) {
      if (part.type === "text") mapped.push({ text: part.text });
      else if (part.type === "tool_call") mapped.push({ functionCall: { id: part.call.id, name: part.call.name, args: part.call.arguments } });
      else if (part.type === "tool_result") mapped.push({ functionResponse: { id: part.callId, name: part.name, response: resultObject(part.content) } });
    }
    return { role: message.role === "assistant" ? "model" : "user", parts: mapped };
  });
}

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = "google";
  private key(credentials: ProviderCredentials): string {
    if (!credentials.apiKey) throw new GatewayError("authentication_failed", "A Google Gemini API key is required.", 401);
    return credentials.apiKey;
  }

  async listModels(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    const models: ProviderModel[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const endpoint = new URL(`${BASE_URL}/models`);
      if (pageToken) endpoint.searchParams.set("pageToken", pageToken);
      const response = await fetch(endpoint.toString(), { headers: { "x-goog-api-key": this.key(credentials) }, signal });
      if (!response.ok) throw await providerError(response);
      const body = await response.json() as { models?: Array<Record<string, unknown>>; nextPageToken?: unknown };
      if (!Array.isArray(body.models)) throw new GatewayError("provider_error", "Gemini returned an invalid model page.", 502);
      models.push(...body.models.flatMap((item) => typeof item.name === "string" ? [{ id: item.name.replace(/^models\//, ""), displayName: typeof item.displayName === "string" ? item.displayName : item.name,
        capabilities: { text: Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes("generateContent") ? "supported" : "unknown", streaming: "conditional", tools: "conditional", structured_output: "conditional" } as const,
        metadata: { inputTokenLimit: item.inputTokenLimit, outputTokenLimit: item.outputTokenLimit, supportedGenerationMethods: item.supportedGenerationMethods } }] : []));
      if (models.length > 10_000) throw new GatewayError("provider_error", "Gemini model discovery exceeded the local model limit.", 502);
      if (body.nextPageToken === undefined || body.nextPageToken === "") return models;
      if (typeof body.nextPageToken !== "string" || seenTokens.has(body.nextPageToken)) throw new GatewayError("provider_error", "Gemini model discovery returned an invalid cursor.", 502);
      seenTokens.add(body.nextPageToken);
      pageToken = body.nextPageToken;
    }
    throw new GatewayError("provider_error", "Gemini model discovery exceeded the local page limit.", 502);
  }

  async *stream(request: GenerateRequest, credentials: ProviderCredentials): AsyncGenerator<GatewayEvent> {
    validateRequestCapabilities(request, { tools: true, structured: "json_schema_and_object", imageUrl: false });
    const systemMessages = request.messages.filter((message) => message.role === "system");
    if (systemMessages.some((message) => contentParts(message.content).some((part) => part.type !== "text"))) throw new GatewayError("unsupported_capability", "Gemini system content supports text only in this adapter.", 400);
    const systemText = systemMessages.map((message) => textContent(message.content)).join("\n\n");
    const endpoint = `${BASE_URL}/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`;
    const apiKey = this.key(credentials);
    let response: Response;
    try {
      request.onDispatch?.();
      response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": apiKey }, signal: request.signal,
        body: JSON.stringify({ contents: messagesForGemini(request.messages), ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }], toolConfig: geminiToolConfig(request.toolChoice) } : {}),
          generationConfig: { ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.responseFormat && request.responseFormat.type !== "text" ? { responseMimeType: "application/json" } : {}), ...(request.responseFormat?.type === "json_schema" ? { responseJsonSchema: request.responseFormat.schema } : {}) } }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw new GatewayError("provider_unavailable", error instanceof Error ? error.message : "Provider request failed.", 503, true);
    }
    if (!response.ok) throw await providerError(response);
    yield { type: "response.started" };
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    let structuredText = "";
    let callIndex = 0;
    const pendingCalls = new Map<string, { index: number; id: string; name: string; arguments: Record<string, unknown> }>();
    try {
      for await (const item of parseSse(response)) {
        const chunk = JSON.parse(item.data) as Record<string, unknown>;
        if (chunk.error) { const detail = chunk.error as Record<string, unknown>; throw new GatewayError("provider_error", typeof detail.message === "string" ? detail.message : "Gemini stream failed."); }
        const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
        if (typeof candidates?.[0]?.finishReason === "string") finishReason = candidates[0].finishReason;
        const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
        const parts = content?.parts as Array<Record<string, unknown>> | undefined;
        for (const part of parts ?? []) {
          if (typeof part.text === "string") { structuredText = appendBoundedUtf8(structuredText, part.text, JSON_SCHEMA_LIMITS.maxOutputBytes, "structured output"); yield { type: "content.delta", text: part.text }; }
          const fn = part.functionCall as Record<string, unknown> | undefined;
          if (fn && typeof fn.name === "string") {
            const providerId = typeof fn.id === "string" ? fn.id : undefined;
            const key = providerId ?? `${fn.name}:${callIndex}`;
            const existing = pendingCalls.get(key);
            const id = providerId ?? existing?.id ?? `gemini-call-${callIndex}`;
            const args = fn.args && !Array.isArray(fn.args) && typeof fn.args === "object" ? fn.args as Record<string, unknown> : {};
            const encodedArgs = JSON.stringify(args);
            if (Buffer.byteLength(encodedArgs, "utf8") > PROVIDER_STREAM_LIMITS.maxToolArgumentsBytes) throw new GatewayError("provider_error", "Provider tool arguments exceeded the local byte limit.", 502);
            const pending = existing ?? { index: callIndex++, id, name: fn.name, arguments: {} };
            const mergedArguments = { ...pending.arguments, ...args };
            if (Buffer.byteLength(JSON.stringify(mergedArguments), "utf8") > PROVIDER_STREAM_LIMITS.maxToolArgumentsBytes) throw new GatewayError("provider_error", "Provider tool arguments exceeded the local byte limit.", 502);
            pending.arguments = mergedArguments;
            pendingCalls.set(key, pending);
            yield { type: "tool_call.delta", index: pending.index, callId: id, name: fn.name, argumentsDelta: JSON.stringify(args) };
          }
        }
        const raw = chunk.usageMetadata as Record<string, unknown> | undefined;
        if (raw) { usage = { inputTokens: typeof raw.promptTokenCount === "number" ? raw.promptTokenCount : undefined, outputTokens: typeof raw.candidatesTokenCount === "number" ? raw.candidatesTokenCount : undefined }; yield { type: "usage.updated", usage }; }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw error instanceof SyntaxError ? new GatewayError("provider_error", "Gemini returned malformed stream JSON.", 502) : error;
    }
    if (!finishReason) throw new GatewayError("provider_error", "Gemini stream ended without a finish reason.", 502, true);
    yield { type: "response.completed", finishReason, usage };
    for (const pending of [...pendingCalls.values()].sort((left, right) => left.index - right.index)) yield { type: "tool_call.completed", index: pending.index, call: { id: pending.id, name: pending.name, arguments: pending.arguments } };
    if (request.responseFormat && request.responseFormat.type !== "text" && pendingCalls.size === 0) yield { type: "structured_output.completed", value: parseStructuredOutput(structuredText, request.responseFormat.type === "json_schema" ? request.responseFormat.schema : undefined) };
  }
}
