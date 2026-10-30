import { GatewayError, providerError } from "@/src/modules/gateway/errors";
import { parseSse } from "@/src/modules/gateway/streaming";
import type { GatewayEvent, GenerateRequest, ProviderAdapter, ProviderCredentials, ProviderModel, Usage } from "@/src/modules/gateway/types";

const BASE_URL = "https://api.anthropic.com";

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic";

  private headers(credentials: ProviderCredentials): HeadersInit {
    if (!credentials.apiKey) throw new GatewayError("authentication_failed", "An Anthropic API key is required.", 401);
    return { "content-type": "application/json", "x-api-key": credentials.apiKey, "anthropic-version": "2023-06-01" };
  }

  async listModels(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    const response = await fetch(`${BASE_URL}/v1/models`, { headers: this.headers(credentials), signal });
    if (!response.ok) throw await providerError(response);
    const body = await response.json() as { data?: Array<Record<string, unknown>> };
    return (body.data ?? []).flatMap((item) => typeof item.id === "string" ? [{
      id: item.id,
      displayName: typeof item.display_name === "string" ? item.display_name : item.id,
      capabilities: { text: "supported", streaming: "supported", tools: "unknown", structured_output: "unknown" } as const,
      metadata: { createdAt: item.created_at },
    }] : []);
  }

  async *stream(request: GenerateRequest, credentials: ProviderCredentials): AsyncGenerator<GatewayEvent> {
    const system = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const messages = request.messages.filter((message) => message.role !== "system" && message.role !== "tool").map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
    const headers = this.headers(credentials);
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers,
        signal: request.signal,
        body: JSON.stringify({ model: request.modelId, messages, stream: true, max_tokens: request.maxOutputTokens ?? 2048, ...(system ? { system } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) }),
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
        if (item.event === "content_block_delta") {
          const delta = chunk.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") yield { type: "content.delta", text: delta.text };
        }
        if (item.event === "message_delta") {
          const delta = chunk.delta as Record<string, unknown> | undefined;
          if (typeof delta?.stop_reason === "string") finishReason = delta.stop_reason;
          const raw = chunk.usage as Record<string, unknown> | undefined;
          if (raw) {
            usage = { ...usage, outputTokens: typeof raw.output_tokens === "number" ? raw.output_tokens : undefined };
            yield { type: "usage.updated", usage };
          }
        }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw error;
    }
    if (!sawTerminal) throw new GatewayError("provider_error", "Anthropic stream ended without message_stop.", 502, true);
    yield { type: "response.completed", finishReason, usage, providerRequestId: requestId };
  }
}
