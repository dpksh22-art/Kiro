# Model providers

No provider credential was available for this increment. All claims below come from controlled adapter tests, not live conformance.

| Provider | Adapter surface | Tool mapping | Structured output | Image URL input |
|---|---|---|---|---|
| OpenAI, xAI, DeepSeek, Mistral, OpenRouter, Ollama | OpenAI-compatible Chat Completions | `tools`, `tool_choice`, assistant `tool_calls`, tool-result messages, partial argument normalization | Strict `response_format.json_schema`; JSON object mode | Mapped by the contract, but application flows do not expose arbitrary URLs |
| Anthropic | Native Messages | `tool_use`/`tool_result` blocks, native choice, partial `input_json_delta` normalization | Native JSON Schema output configuration; JSON-object-only requests are rejected | Native URL image blocks; application flows remain gated |
| Google Gemini | Native GenerateContent | Function declarations, function calls/responses, native function-calling configuration | `responseMimeType` and `responseJsonSchema` | Rejected by this adapter because generic HTTPS URLs are not the native file surface |

## Canonical contract

Messages remain backward compatible with string content and may also contain discriminated text, image URL, artifact reference, tool call, and tool result parts. Unresolved artifact references are rejected before network dispatch. Tools have a name, description, and JSON Schema. Tool choice supports auto, none, required, or one named tool. Response format supports text, JSON object where available, or strict named JSON Schema.

Adapters validate the canonical schema locally, then translate a separate wire schema. OpenAI strict schemas recursively require every property and represent locally optional values as nullable; returned wire-only nulls normalize back to omission before exact local validation while explicitly nullable values remain. Open or composed canonical object schemas are rejected for OpenAI strict mode rather than falsely advertised; callers can simplify them or choose a provider with explicit support. Anthropic wire schemas remove unsupported assertion keywords while the unchanged canonical schema remains authoritative after the response. Provider capability values remain explicit `supported`, `unsupported`, `conditional`, or `unknown`; translation does not promote a conditional capability. Anthropic and Gemini discovery follows bounded cursors and commits only complete snapshots.

## Artifact and image boundary

Only the server can resolve an artifact. The current scanner promotes only UTF-8 text and JSON, so agent artifact input is implemented through `artifact_text_read`. It checks owner, clean upload state, clean scan state, media type, byte cap, and UTF-8 before returning content with provenance. No filesystem path reaches a provider or model. Images remain gated until a scanner can promote them safely, even though provider mappings are represented and tested.

## Common behavior

Credentials remain encrypted server-side. Provider errors use normalized categories. Usage and cost reservations remain separate, and each agent provider turn reserves independently. Unknown price still fails closed when an applicable hard monetary budget exists. Provider website subscriptions are not API credentials.
