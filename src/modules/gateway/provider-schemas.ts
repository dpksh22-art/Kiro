import { GatewayError } from "@/src/modules/gateway/errors";
import { assertSafeJsonSchema } from "@/src/modules/gateway/schema-validation";
import type { JsonSchema } from "@/src/modules/gateway/types";

const ANTHROPIC_UNSUPPORTED_VALIDATION_KEYWORDS = new Set([
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function nullable(schema: JsonSchema): JsonSchema {
  const type = schema.type;
  if (typeof type === "string") return { ...schema, type: type === "null" ? "null" : [type, "null"] };
  if (Array.isArray(type)) return { ...schema, type: [...new Set([...type, "null"])] };
  return { anyOf: [schema, { type: "null" }] };
}

/** Translate the safe local subset into OpenAI's strict function/response schema dialect. */
export function openAIStrictWireSchema(schema: JsonSchema): JsonSchema {
  assertSafeJsonSchema(schema);
  const visit = (node: JsonSchema): JsonSchema => {
    if (["allOf", "anyOf", "oneOf", "not"].some((keyword) => node[keyword] !== undefined)) {
      throw new GatewayError("unsupported_capability", "OpenAI strict schemas do not accept this local composition shape; use a provider with explicit support or simplify the schema.", 400);
    }
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      throw new GatewayError("unsupported_capability", "OpenAI strict object schemas require additionalProperties to be false.", 400);
    }
    const output: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isRecord(value)) {
        const locallyRequired = new Set(Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === "string") : []);
        const properties = Object.fromEntries(Object.entries(value).map(([name, child]) => {
          const translated = visit(child as JsonSchema);
          return [name, locallyRequired.has(name) ? translated : nullable(translated)];
        }));
        output.properties = properties;
        output.required = Object.keys(properties);
      } else if (key === "required" && isRecord(node.properties)) {
        // Replaced by the exhaustive strict-mode required list above.
      } else if (key === "items" && isRecord(value)) output.items = visit(value);
      else if (key === "additionalProperties" && isRecord(value)) output.additionalProperties = visit(value);
      else if (key === "not" && isRecord(value)) output.not = visit(value);
      else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(value)) output[key] = value.map((child) => visit(child as JsonSchema));
      else output[key] = value;
    }
    if (output.type === "object" && output.additionalProperties === undefined) output.additionalProperties = false;
    return output;
  };
  return visit(schema);
}

/** Anthropic strips unsupported assertion keywords on the wire; the canonical schema is still validated locally. */
export function anthropicWireSchema(schema: JsonSchema): JsonSchema {
  assertSafeJsonSchema(schema);
  const visit = (node: JsonSchema): JsonSchema => {
    const output: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (ANTHROPIC_UNSUPPORTED_VALIDATION_KEYWORDS.has(key)) continue;
      if (key === "properties" && isRecord(value)) output.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child as JsonSchema)]));
      else if (key === "items" && isRecord(value)) output.items = visit(value);
      else if (key === "additionalProperties" && isRecord(value)) output.additionalProperties = visit(value);
      else if (key === "not" && isRecord(value)) output.not = visit(value);
      else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(value)) output[key] = value.map((child) => visit(child as JsonSchema));
      else output[key] = value;
    }
    return output;
  };
  return visit(schema);
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
  return ["anyOf", "oneOf"].some((key) => Array.isArray(schema[key]) && (schema[key] as unknown[]).some(schemaAllowsNull));
}

/** Convert OpenAI's nullable representation of locally optional fields back to omission. */
export function normalizeOpenAIOptionalValue(value: unknown, schema: JsonSchema): unknown {
  const visit = (current: unknown, node: JsonSchema): unknown => {
    if (Array.isArray(current)) return current.map((item) => isRecord(node.items) ? visit(item, node.items) : item);
    if (!isRecord(current) || !isRecord(node.properties)) return current;
    const required = new Set(Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === "string") : []);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      const childSchema = node.properties[key];
      if (child === null && childSchema !== undefined && !required.has(key) && !schemaAllowsNull(childSchema)) continue;
      result[key] = isRecord(childSchema) ? visit(child, childSchema) : child;
    }
    return result;
  };
  return visit(value, schema);
}

export function normalizeOpenAIOptionalValues(value: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const normalized = normalizeOpenAIOptionalValue(value, schema);
  if (!isRecord(normalized)) throw new GatewayError("provider_error", "Provider returned invalid tool arguments.", 502);
  return normalized;
}
