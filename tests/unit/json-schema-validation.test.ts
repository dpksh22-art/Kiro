import { describe, expect, it } from "vitest";
import { parseStructuredOutput, validateRequestCapabilities } from "@/src/modules/gateway/mapping";
import { assertSafeJsonSchema, JSON_SCHEMA_LIMITS, validateStructuredOutput } from "@/src/modules/gateway/schema-validation";
import type { GenerateRequest, JsonSchema } from "@/src/modules/gateway/types";

const schema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    scores: { type: "array", items: { type: "number" } },
    detail: { type: "object", additionalProperties: false, properties: { active: { type: "boolean" } }, required: ["active"] },
  },
  required: ["name", "scores", "detail"],
};

function request(outputSchema: JsonSchema): GenerateRequest {
  return { modelId: "model", messages: [{ role: "user", content: "json" }], responseFormat: { type: "json_schema", name: "result", schema: outputSchema, strict: true } };
}

const features = { tools: true, structured: "json_schema_and_object" as const, imageUrl: true };

describe("local structured output validation", () => {
  it("accepts a conforming nested object and validates before provider dispatch", () => {
    expect(() => validateRequestCapabilities(request(schema), features)).not.toThrow();
    expect(parseStructuredOutput('{"name":"Ada","scores":[1,2],"detail":{"active":true}}', schema)).toEqual({ name: "Ada", scores: [1, 2], detail: { active: true } });
  });

  it.each([
    ["required fields", { scores: [1], detail: { active: true } }],
    ["property types", { name: "Ada", scores: ["1"], detail: { active: true } }],
    ["array shape", { name: "Ada", scores: 1, detail: { active: true } }],
    ["additional properties", { name: "Ada", scores: [1], detail: { active: true }, invented: true }],
    ["nested required fields", { name: "Ada", scores: [1], detail: {} }],
  ])("rejects provider output that violates %s", (_name, value) => {
    expect(() => validateStructuredOutput(value, schema)).toThrowError(/did not match the requested schema/i);
    try { validateStructuredOutput(value, schema); } catch (error) { expect(error).toMatchObject({ code: "provider_error", status: 502 }); }
  });

  it("does not coerce values, insert defaults, or remove additional properties", () => {
    const value = { name: "Ada", scores: ["2"], detail: { active: true }, extra: "remove-me" };
    expect(() => validateStructuredOutput(value, schema)).toThrow();
    expect(value).toEqual({ name: "Ada", scores: ["2"], detail: { active: true }, extra: "remove-me" });
  });

  it("rejects malformed JSON and non-object json_object output with normalized provider errors", () => {
    expect(() => parseStructuredOutput("{bad", schema)).toThrowError(/invalid structured JSON/i);
    expect(() => parseStructuredOutput("[]")).toThrowError(/invalid structured JSON/i);
  });

  it.each([
    ["unknown keyword", { type: "object", transform: ["trim"] }],
    ["references", { type: "object", $ref: "https://example.com/schema" }],
    ["regular-expression keywords", { type: "string", pattern: "(a+)+$" }],
    ["malformed required", { type: "object", required: "name" }],
    ["invalid type", { type: "not-a-json-type" }],
  ])("rejects unsafe or invalid schemas: %s", (_name, unsafe) => {
    expect(() => assertSafeJsonSchema(unsafe as JsonSchema)).toThrowError(/unsafe or invalid JSON Schema/i);
    try { assertSafeJsonSchema(unsafe as JsonSchema); } catch (error) { expect(error).toMatchObject({ code: "request_invalid", status: 400 }); }
  });

  it("enforces schema size, depth, property, enum, and combinator limits", () => {
    expect(() => assertSafeJsonSchema({ type: "object", description: "x".repeat(JSON_SCHEMA_LIMITS.maxBytes) })).toThrow(/too long|exceeds/i);
    let deep: JsonSchema = { type: "string" };
    for (let index = 0; index <= JSON_SCHEMA_LIMITS.maxDepth; index += 1) deep = { type: "array", items: deep };
    expect(() => assertSafeJsonSchema(deep)).toThrow(/depth exceeds/i);
    const properties = Object.fromEntries(Array.from({ length: JSON_SCHEMA_LIMITS.maxProperties + 1 }, (_, index) => [`p${index}`, { type: "string" }]));
    expect(() => assertSafeJsonSchema({ type: "object", properties })).toThrow(/properties/i);
    expect(() => assertSafeJsonSchema({ type: "string", enum: Array.from({ length: JSON_SCHEMA_LIMITS.maxEnumValues + 1 }, (_, index) => index) })).toThrow(/enum/i);
    expect(() => assertSafeJsonSchema({ oneOf: Array.from({ length: JSON_SCHEMA_LIMITS.maxCombinatorBranches + 1 }, () => ({ type: "string" })) })).toThrow(/branches/i);
  });

  it("rejects provider output with excessive nesting before schema evaluation", () => {
    let value: Record<string, unknown> = {};
    const root = value;
    for (let index = 0; index <= JSON_SCHEMA_LIMITS.maxOutputDepth; index += 1) {
      const child: Record<string, unknown> = {};
      value.child = child;
      value = child;
    }
    expect(() => validateStructuredOutput(root, { type: "object" })).toThrow(/complexity limits/i);
  });
});
