import { GatewayError, providerError } from "@/src/modules/gateway/errors";
import { parseSse } from "@/src/modules/gateway/streaming";
import type { GatewayEvent, GenerateRequest, ProviderAdapter, ProviderCredentials, ProviderModel, Usage } from "@/src/modules/gateway/types";

type Profile = {
  provider: string;
  defaultBaseUrl: string;
  requireKey: boolean;
  headers?: Record<string, string>;
};

function url(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

function usageFrom(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  return {
    inputTokens: typeof item.prompt_tokens === "number" ? item.prompt_tokens : undefined,
    outputTokens: typeof item.completion_tokens === "number" ? item.completion_tokens : undefined,
  };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly provider: string;
  constructor(private readonly profile: Profile) {
    this.provider = profile.provider;
  }

  private headers(credentials: ProviderCredentials): HeadersInit {
    if (this.profile.requireKey && !credentials.apiKey) throw new GatewayError("authentication_failed", "An API key is required.", 401);
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}),
      ...this.profile.headers,
    };
  }

  private base(credentials: ProviderCredentials): string {
    return credentials.baseUrl || this.profile.defaultBaseUrl;
  }

  async listModels(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]> {
    const response = await fetch(url(this.base(credentials), "/v1/models"), { headers: this.headers(credentials), signal });
    if (!response.ok) throw await providerError(response);
    const body = await response.json() as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(body.data)) throw new GatewayError("provider_error", "Provider returned an invalid model list.");
    return body.data.flatMap((item) => typeof item.id === "string" ? [{
      id: item.id,
      displayName: typeof item.name === "string" ? item.name : item.id,
      capabilities: { text: "conditional", streaming: "conditional", tools: "unknown", structured_output: "unknown" },
      metadata: { ownedBy: item.owned_by },
    }] : []);
  }

  async *stream(request: GenerateRequest, credentials: ProviderCredentials): AsyncGenerator<GatewayEvent> {
    let response: Response;
    try {
      response = await fetch(url(this.base(credentials), "/v1/chat/completions"), {
        method: "POST",
        headers: this.headers(credentials),
        signal: request.signal,
        body: JSON.stringify({
          model: request.modelId,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
      });
    } catch (error) {
      if (request.signal?.aborted) throw new GatewayError("cancelled", "Request cancelled.", 499);
      throw new GatewayError("provider_unavailable", error instanceof Error ? error.message : "Provider request failed.", 503, true);
    }
    if (!response.ok) throw await providerError(response);
    yield { type: "response.started", providerRequestId: response.headers.get("x-request-id") ?? undefined };
    let finalUsage: Usage | undefined;
    let sawTerminal = false;
    for await (const item of parseSse(response)) {
      if (item.data === "[DONE]") { sawTerminal = true; break; }
      const chunk = JSON.parse(item.data) as Record<string, unknown>;
      if (chunk.error) {
        const providerMessage = (chunk.error as Record<string, unknown>).message;
        throw new GatewayError("provider_error", typeof providerMessage === "string" ? providerMessage : "Provider stream failed.");
      }
      const choices = Array.isArray(chunk.choices) ? chunk.choices as Array<Record<string, unknown>> : [];
      const delta = choices[0]?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string" && delta.content) yield { type: "content.delta", text: delta.content };
      const parsedUsage = usageFrom(chunk.usage);
      if (parsedUsage) {
        finalUsage = parsedUsage;
        yield { type: "usage.updated", usage: parsedUsage };
      }
    }
    if (!sawTerminal) throw new GatewayError("provider_error", "Provider stream ended without a terminal marker.", 502, true);
    yield { type: "response.completed", usage: finalUsage, providerRequestId: response.headers.get("x-request-id") ?? undefined };
  }
}
