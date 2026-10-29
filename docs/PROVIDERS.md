# Model providers

Verified against official documentation on 2026-10-29. A provider-level API feature does not prove that every model supports it. NEXUS keeps model-level status unknown until discovery metadata or a controlled probe supports a claim.

| Provider | Adapter | Authentication | Live-tested here | Notes |
|---|---|---|---|---|
| OpenAI | OpenAI-compatible Chat Completions | API key | No | Streaming and usage normalized. Responses API and native multimodal inputs are future work. |
| Anthropic | Native Messages | API key | No | Native system message, SSE blocks, token usage, and required `message_stop` handled. |
| Google Gemini | Native GenerateContent | API key | No | Native model discovery and SSE generation; finish reason required. |
| xAI | OpenAI-compatible profile | API key | No | Advanced Responses features are outside the current profile. |
| DeepSeek | OpenAI-compatible profile | API key | No | Provider-specific reasoning and Responses semantics are outside the current profile. |
| Mistral | OpenAI-compatible profile | API key | No | Native agents and preview Responses features are outside the current profile. |
| OpenRouter | OpenAI-compatible profile | API key | No | Route capabilities and pricing remain provider metadata, not assumptions. |
| Ollama | OpenAI-compatible local profile | None locally | No | Server operator controls `OLLAMA_BASE_URL`; browser users cannot point research or inference at arbitrary private hosts. |

## Common behavior

- Credentials are encrypted server-side and omitted from API responses.
- Validation calls each provider's documented model-list endpoint.
- Requests use cancellation signals, a task deadline, and normalized error categories.
- HTTP authentication, rate-limit, not-found, and server failures receive distinct errors.
- In-band stream errors and truncated streams fail rather than becoming successful empty answers.
- Usage keeps input, output, estimated cost, billed cost, and currency separate.
- Monetary budgets reserve documented cost before dispatch and settle from reported usage.
- Operators can attach a source URL, observation time, currency, and per-million rates to a discovered model; NEXUS never invents these values.
- Unknown price fails closed when an applicable hard monetary budget exists.

## Authentication reality

Provider website subscriptions are not API credentials. NEXUS accepts documented API keys and local endpoints. It does not collect provider website passwords, reuse browser cookies, reverse-engineer private endpoints, or bypass subscription restrictions.

## Primary documentation

- [OpenAI API](https://developers.openai.com/api/reference/overview)
- [Anthropic API](https://platform.claude.com/docs/en/api/getting-started)
- [Google Gemini API](https://ai.google.dev/gemini-api/docs)
- [xAI API](https://docs.x.ai/docs/overview)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [Mistral API](https://docs.mistral.ai/api/)
- [Ollama OpenAI compatibility](https://docs.ollama.com/openai)
- [OpenRouter API](https://openrouter.ai/docs/api/reference/overview)
- [LiteLLM documentation](https://docs.litellm.ai/docs/)
- [Vercel AI SDK](https://ai-sdk.dev/docs/introduction)

Content from linked sources was rephrased for compliance with licensing restrictions.
