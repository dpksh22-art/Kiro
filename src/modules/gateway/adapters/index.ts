import { getConfig } from "@/src/core/config";
import { AnthropicAdapter } from "@/src/modules/gateway/adapters/anthropic";
import { GeminiAdapter } from "@/src/modules/gateway/adapters/gemini";
import { OpenAICompatibleAdapter } from "@/src/modules/gateway/adapters/openai-compatible";
import type { ProviderAdapter } from "@/src/modules/gateway/types";

const adapters: Record<string, ProviderAdapter> = {
  openai: new OpenAICompatibleAdapter({ provider: "openai", defaultBaseUrl: "https://api.openai.com", requireKey: true }),
  anthropic: new AnthropicAdapter(),
  google: new GeminiAdapter(),
  xai: new OpenAICompatibleAdapter({ provider: "xai", defaultBaseUrl: "https://api.x.ai", requireKey: true }),
  deepseek: new OpenAICompatibleAdapter({ provider: "deepseek", defaultBaseUrl: "https://api.deepseek.com", requireKey: true }),
  mistral: new OpenAICompatibleAdapter({ provider: "mistral", defaultBaseUrl: "https://api.mistral.ai", requireKey: true }),
  openrouter: new OpenAICompatibleAdapter({ provider: "openrouter", defaultBaseUrl: "https://openrouter.ai/api", requireKey: true, headers: { "HTTP-Referer": "https://nexus.local", "X-Title": "NEXUS AI OS" } }),
  ollama: new OpenAICompatibleAdapter({ provider: "ollama", defaultBaseUrl: getConfig().OLLAMA_BASE_URL, requireKey: false }),
};

export const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(adapters));

export function getAdapter(provider: string): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) throw new Error(`Unsupported provider: ${provider}`);
  return adapter;
}
