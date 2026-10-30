import { GatewayError } from "@/src/modules/gateway/errors";
import { assertSafeJsonSchema, JSON_SCHEMA_LIMITS, validateJsonObjectOutput, validateStructuredOutput } from "@/src/modules/gateway/schema-validation";
import type { GatewayContentPart, GenerateRequest, JsonSchema, ToolCall, ToolChoice } from "@/src/modules/gateway/types";

export type AdapterFeatures = { tools: boolean; structured: "none" | "json_schema" | "json_schema_and_object"; imageUrl: boolean };

export function contentParts(content: string | GatewayContentPart[]): GatewayContentPart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

export function textContent(content: string | GatewayContentPart[]): string {
  return contentParts(content).flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

export function validateRequestCapabilities(request: GenerateRequest, features: AdapterFeatures): void {
  const usesTools = Boolean(request.tools?.length) || request.messages.some((message) => contentParts(message.content).some((part) => part.type === "tool_call" || part.type === "tool_result"));
  if (usesTools && !features.tools) throw new GatewayError("unsupported_capability", "This provider adapter does not support tools.", 400);
  if (request.toolChoice && request.toolChoice !== "none" && !request.tools?.length) throw new GatewayError("request_invalid", "Tool choice requires declared tools.", 400);
  if (request.responseFormat?.type === "json_schema") {
    if (features.structured === "none") throw new GatewayError("unsupported_capability", "This provider adapter does not support JSON Schema output.", 400);
    assertSafeJsonSchema(request.responseFormat.schema);
  }
  if (request.responseFormat?.type === "json_object" && features.structured !== "json_schema_and_object") throw new GatewayError("unsupported_capability", "This provider adapter does not support JSON object output.", 400);
  for (const message of request.messages) {
    for (const part of contentParts(message.content)) {
      if (part.type === "artifact_reference") throw new GatewayError("request_invalid", "Artifact references must be owner-scoped, scanned, and resolved by the server before provider dispatch.", 400);
      if (part.type === "image_url") {
        if (!features.imageUrl) throw new GatewayError("unsupported_capability", "This provider adapter does not support image URL input.", 400);
        let parsed: URL;
        try { parsed = new URL(part.url); } catch { throw new GatewayError("request_invalid", "Image URL is invalid.", 400); }
        if (parsed.protocol !== "https:") throw new GatewayError("request_invalid", "Image URLs must use HTTPS.", 400);
      }
    }
  }
}

export function openAIToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice || typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

export function anthropicToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice || choice === "auto") return { type: "auto" };
  if (choice === "none") return undefined;
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

export function geminiToolConfig(choice: ToolChoice | undefined): unknown {
  if (!choice || choice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
}

export function parseToolArguments(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new GatewayError("provider_error", `Provider returned invalid JSON arguments for tool ${name}.`, 502);
  }
}

export function parseStructuredOutput(text: string, schema?: JsonSchema, normalize?: (value: unknown) => unknown): unknown {
  if (Buffer.byteLength(text, "utf8") > JSON_SCHEMA_LIMITS.maxOutputBytes) {
    throw new GatewayError("provider_error", "Provider returned structured output that exceeded the local size limit.", 502);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
    if (normalize) value = normalize(value);
  } catch {
    throw new GatewayError("provider_error", "Provider returned invalid structured JSON output.", 502);
  }
  return schema ? validateStructuredOutput(value, schema) : validateJsonObjectOutput(value);
}

export type PendingToolCall = { id: string; name: string; argumentsText: string };
export function completedToolCall(pending: PendingToolCall): ToolCall {
  return { id: pending.id, name: pending.name, arguments: parseToolArguments(pending.argumentsText, pending.name) };
}
