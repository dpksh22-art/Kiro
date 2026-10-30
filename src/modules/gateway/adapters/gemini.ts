import { GatewayError, providerError } from "@/src/modules/gateway/errors";
import { parseSse } from "@/src/modules/gateway/streaming";
import type { GatewayEvent, GenerateRequest, ProviderAdapter, ProviderCredentials, ProviderModel, Usage } from "@/src/modules/gateway/types";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiAdapter implements ProviderAdapter {
  readonly provider = "google";

  private key(credentials: ProviderCredentials): string {
    if (!credentials.apiKey) throw new GatewayError("authentication_failed", "A Google Gemini API key is required.", 401);
    return credentials.apiKey;
  }

  async listModels(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    const response = await fetch(`${BASE_URL}/models`, { headers: { "x-goog-api-key": this.key(credentials) }, signal });
    if (!response.ok) throw await providerError(response);
    const body = await response.json() as { models?: Array<Record<string, unknown>> };
    return (body.models ?? []).flatMap((item) => typeof item.name === "string" ? [{
      id: item.name.replace(/^models\//, ""),
      displayName: typeof item.displayName === "string" ? item.displayName : item.name,
      capabilities: {
        text: Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes("generateContent") ? "supported" : "unknown",
        streaming: "conditional",
        tools: "unknown",
        structured_output: "unknown",
      } as const,
      metadata: {
        inputTokenLimit: item.inputTokenLimit,
        outputTokenLimit: item.outputTokenLimit,
        supportedGenerationMethods: item.supportedGenerationMethods,
      },
    }] : []);
  }

  async *stream(request: GenerateRequest, credentials: ProviderCredentials): AsyncGenerator<GatewayEvent> {
    const systemText = request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const contents = request.messages.filter((message) => message.role !== "system" && message.role !== "tool").map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
    const endpoint = `${BASE_URL}/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`;
    const apiKey = this.key(credentials);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        signal: request.signal,
        body: JSON.stringify({
          contents,
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          generationConfig: { ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) },
        }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw new GatewayError("provider_unavailable", error instanceof Error ? error.message : "Provider request failed.", 503, true);
    }
    if (!response.ok) throw await providerError(response);
    yield { type: "response.started" };
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    try {
      for await (const item of parseSse(response)) {
        const chunk = JSON.parse(item.data) as Record<string, unknown>;
        if (chunk.error) {
          const detail = chunk.error as Record<string, unknown>;
          throw new GatewayError("provider_error", typeof detail.message === "string" ? detail.message : "Gemini stream failed.");
        }
        const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
        if (typeof candidates?.[0]?.finishReason === "string") finishReason = candidates[0].finishReason;
        const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
        const parts = content?.parts as Array<Record<string, unknown>> | undefined;
        for (const part of parts ?? []) if (typeof part.text === "string") yield { type: "content.delta", text: part.text };
        const raw = chunk.usageMetadata as Record<string, unknown> | undefined;
        if (raw) {
          usage = { inputTokens: typeof raw.promptTokenCount === "number" ? raw.promptTokenCount : undefined, outputTokens: typeof raw.candidatesTokenCount === "number" ? raw.candidatesTokenCount : undefined };
          yield { type: "usage.updated", usage };
        }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw error;
    }
    if (!finishReason) throw new GatewayError("provider_error", "Gemini stream ended without a finish reason.", 502, true);
    yield { type: "response.completed", finishReason, usage };
  }
}
