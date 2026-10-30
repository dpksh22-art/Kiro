export const CAPABILITIES = [
  "text", "streaming", "vision", "image_generation", "audio_input", "audio_output",
  "tools", "structured_output", "embeddings", "files",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityState = "supported" | "unsupported" | "conditional" | "unknown";

export type JsonSchema = Record<string, unknown>;

export type TextContentPart = { type: "text"; text: string };
/** External image URLs are accepted only by explicitly trusted server-side callers. Browser APIs do not expose this part. */
export type ImageUrlContentPart = { type: "image_url"; url: string; mediaType?: "image/png" | "image/jpeg" | "image/gif" | "image/webp" };
/** An unresolved reference is never sent to a provider. Server code must replace it with scanned content first. */
export type ArtifactReferenceContentPart = { type: "artifact_reference"; artifactId: string };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type ToolCallContentPart = { type: "tool_call"; call: ToolCall };
export type ToolResultContentPart = { type: "tool_result"; callId: string; name: string; content: string; isError?: boolean };
export type GatewayContentPart = TextContentPart | ImageUrlContentPart | ArtifactReferenceContentPart | ToolCallContentPart | ToolResultContentPart;

export type GatewayMessage = {
  role: "system" | "user" | "assistant" | "tool";
  /** Strings remain supported for existing callers. */
  content: string | GatewayContentPart[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ToolChoice = "auto" | "none" | "required" | { type: "tool"; name: string };
export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: JsonSchema; strict: true };

export type GenerateRequest = {
  modelId: string;
  messages: GatewayMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  /** Called exactly once immediately before the adapter starts the provider request. */
  onDispatch?: () => void;
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
  | { type: "tool_call.delta"; index: number; callId?: string; name?: string; argumentsDelta?: string }
  | { type: "tool_call.completed"; index: number; call: ToolCall }
  | { type: "structured_output.completed"; value: unknown }
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
