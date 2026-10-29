export const CAPABILITIES = [
  "text", "streaming", "vision", "image_generation", "audio_input", "audio_output",
  "tools", "structured_output", "embeddings", "files",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityState = "supported" | "unsupported" | "conditional" | "unknown";

export type GatewayMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type GenerateRequest = {
  modelId: string;
  messages: GatewayMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  billedCostMicros?: number;
  currency?: string;
};

export type GatewayEvent =
  | { type: "response.started"; providerRequestId?: string }
  | { type: "content.delta"; text: string }
  | { type: "usage.updated"; usage: Usage }
  | { type: "response.completed"; finishReason?: string; usage?: Usage; providerRequestId?: string };

export type ProviderModel = {
  id: string;
  displayName: string;
  capabilities: Partial<Record<Capability, CapabilityState>>;
  metadata?: Record<string, unknown>;
};

export type ProviderCredentials = {
  apiKey?: string;
  baseUrl?: string;
};

export interface ProviderAdapter {
  readonly provider: string;
  listModels(credentials: ProviderCredentials, signal?: AbortSignal): Promise<ProviderModel[]>;
  stream(request: GenerateRequest, credentials: ProviderCredentials): AsyncGenerator<GatewayEvent>;
}
