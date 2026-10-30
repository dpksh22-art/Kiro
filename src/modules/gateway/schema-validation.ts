import Ajv, { type ValidateFunction } from "ajv";
import { GatewayError } from "@/src/modules/gateway/errors";
import type { JsonSchema } from "@/src/modules/gateway/types";

export const JSON_SCHEMA_LIMITS = Object.freeze({
  maxBytes: 20_000,
  maxDepth: 16,
  maxNodes: 512,
  maxProperties: 128,
  maxRequired: 128,
  maxEnumValues: 128,
  maxCombinatorBranches: 16,
  maxDescriptionLength: 2_000,
  maxOutputBytes: 1_000_000,
  maxOutputDepth: 64,
  maxOutputNodes: 100_000,
});

const ALLOWED_KEYWORDS = new Set([
  "$comment", "title", "description", "type", "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "enum", "const", "minProperties", "maxProperties",
  "allOf", "anyOf", "oneOf", "not",
]);
const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;
const validatorCache = new WeakMap<object, ValidateFunction>();
const ajv = new Ajv({
  allErrors: false,
  strict: true,
  validateSchema: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  addUsedSchema: false,
});

function invalidSchema(message: string): never {
  throw new GatewayError("request_invalid", `Unsafe or invalid JSON Schema: ${message}`, 400);
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inspectSchemaNode(value: unknown, depth: number, state: { nodes: number; properties: number }, seen: Set<object>): void {
  if (!objectRecord(value)) invalidSchema("every schema node must be an object.");
  if (seen.has(value)) invalidSchema("cyclic schemas are not accepted.");
  seen.add(value);
  state.nodes += 1;
  if (state.nodes > JSON_SCHEMA_LIMITS.maxNodes) invalidSchema(`schema nodes exceed ${JSON_SCHEMA_LIMITS.maxNodes}.`);
  if (depth > JSON_SCHEMA_LIMITS.maxDepth) invalidSchema(`schema depth exceeds ${JSON_SCHEMA_LIMITS.maxDepth}.`);

  for (const keyword of Object.keys(value)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) invalidSchema(`keyword ${keyword} is not in the supported local subset.`);
  }
  if (typeof value.description === "string" && value.description.length > JSON_SCHEMA_LIMITS.maxDescriptionLength) invalidSchema("description is too long.");
  if (typeof value.title === "string" && value.title.length > JSON_SCHEMA_LIMITS.maxDescriptionLength) invalidSchema("title is too long.");

  if (value.properties !== undefined) {
    if (!objectRecord(value.properties)) invalidSchema("properties must be an object.");
    const entries = Object.entries(value.properties);
    if (entries.length > JSON_SCHEMA_LIMITS.maxProperties) invalidSchema(`one object has more than ${JSON_SCHEMA_LIMITS.maxProperties} properties.`);
    state.properties += entries.length;
    if (state.properties > JSON_SCHEMA_LIMITS.maxProperties) invalidSchema(`total properties exceed ${JSON_SCHEMA_LIMITS.maxProperties}.`);
    for (const [, child] of entries) inspectSchemaNode(child, depth + 1, state, seen);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string")) invalidSchema("required must be an array of property names.");
    if (value.required.length > JSON_SCHEMA_LIMITS.maxRequired) invalidSchema(`required entries exceed ${JSON_SCHEMA_LIMITS.maxRequired}.`);
    if (new Set(value.required).size !== value.required.length) invalidSchema("required entries must be unique.");
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) invalidSchema("enum must be a non-empty array.");
    if (value.enum.length > JSON_SCHEMA_LIMITS.maxEnumValues) invalidSchema(`enum values exceed ${JSON_SCHEMA_LIMITS.maxEnumValues}.`);
  }
  if (value.items !== undefined) inspectSchemaNode(value.items, depth + 1, state, seen);
  if (objectRecord(value.additionalProperties)) inspectSchemaNode(value.additionalProperties, depth + 1, state, seen);
  else if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") invalidSchema("additionalProperties must be a boolean or schema.");
  if (value.not !== undefined) inspectSchemaNode(value.not, depth + 1, state, seen);
  for (const keyword of COMBINATORS) {
    const branches = value[keyword];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) invalidSchema(`${keyword} must be a non-empty array.`);
    if (branches.length > JSON_SCHEMA_LIMITS.maxCombinatorBranches) invalidSchema(`${keyword} has too many branches.`);
    for (const branch of branches) inspectSchemaNode(branch, depth + 1, state, seen);
  }
  seen.delete(value);
}

export function assertSafeJsonSchema(schema: JsonSchema): void {
  if (!objectRecord(schema)) invalidSchema("schema must be an object.");
  let encoded: string;
  try { encoded = JSON.stringify(schema); } catch { invalidSchema("schema must be JSON serializable."); }
  if (Buffer.byteLength(encoded!, "utf8") > JSON_SCHEMA_LIMITS.maxBytes) invalidSchema(`serialized schema exceeds ${JSON_SCHEMA_LIMITS.maxBytes} bytes.`);
  inspectSchemaNode(schema, 0, { nodes: 0, properties: 0 }, new Set());
  try {
    if (!ajv.validateSchema(schema)) invalidSchema("schema does not conform to the supported JSON Schema draft.");
    if (!validatorCache.has(schema)) validatorCache.set(schema, ajv.compile(schema));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    invalidSchema("schema could not be compiled.");
  }
}

function assertBoundedOutput(value: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new GatewayError("provider_error", "Provider returned invalid structured JSON output.", 502); }
  if (encoded === undefined) throw new GatewayError("provider_error", "Provider returned invalid structured JSON output.", 502);
  if (Buffer.byteLength(encoded, "utf8") > JSON_SCHEMA_LIMITS.maxOutputBytes) throw new GatewayError("provider_error", "Provider returned structured output that exceeded the local size limit.", 502);
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > JSON_SCHEMA_LIMITS.maxOutputNodes || current.depth > JSON_SCHEMA_LIMITS.maxOutputDepth) {
      throw new GatewayError("provider_error", "Provider returned structured output that exceeded local complexity limits.", 502);
    }
    if (Array.isArray(current.value)) for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    else if (current.value && typeof current.value === "object") for (const child of Object.values(current.value as Record<string, unknown>)) stack.push({ value: child, depth: current.depth + 1 });
  }
}

export function validateStructuredOutput(value: unknown, schema: JsonSchema): unknown {
  assertBoundedOutput(value);
  assertSafeJsonSchema(schema);
  const validate = validatorCache.get(schema)!;
  if (!validate(value)) throw new GatewayError("provider_error", "Provider returned structured output that did not match the requested schema.", 502);
  return value;
}

export function validateJsonObjectOutput(value: unknown): unknown {
  assertBoundedOutput(value);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new GatewayError("provider_error", "Provider returned invalid structured JSON output.", 502);
  return value;
}
